use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use starknet::ContractAddress;
use super::keccak_helper::{keccak_felt252_to_felt252};

// Constants for native ETH handling on Starknet
const ETH_CONTRACT_ADDRESS: felt252 =
    0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7;

#[derive(Copy, Drop, PartialEq, Serde, starknet::Store)]
pub struct Timelocks {
    pub withdrawal: u64,
    pub public_withdrawal: u64,
    pub cancellation: u64,
}

#[derive(Copy, Drop, PartialEq, Serde, starknet::Store)]
pub enum EscrowStatus {
    #[default]
    Uninitialized,
    Active,
    Withdrawn,
    Cancelled,
}

#[derive(Drop, Serde, starknet::Store)]
pub struct Escrow {
    pub maker: ContractAddress,
    pub taker: ContractAddress,
    pub token: ContractAddress,
    pub amount: u256,
    pub safety_deposit: u256,
    pub hashlock: felt252,
    pub timelocks: Timelocks,
    pub status: EscrowStatus,
}

#[starknet::interface]
pub trait IStarknetEscrow<TContractState> {
    fn create_escrow(
        ref self: TContractState,
        escrow_id: felt252,
        maker: ContractAddress,
        token: ContractAddress,
        amount: u256,
        safety_deposit: u256,
        hashlock: felt252,
        timelocks: Timelocks,
    );
    fn withdraw(ref self: TContractState, escrow_id: felt252, secret: felt252);
    fn cancel(ref self: TContractState, escrow_id: felt252);
    fn get_escrow(self: @TContractState, escrow_id: felt252) -> Escrow;
    fn escrow_exists(self: @TContractState, escrow_id: felt252) -> bool;
}

#[starknet::contract]
pub mod StarknetEscrow {
    use core::num::traits::Zero;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use super::{
        ETH_CONTRACT_ADDRESS, Escrow, EscrowStatus, IERC20Dispatcher, IERC20DispatcherTrait,
        IStarknetEscrow, Timelocks, keccak_felt252_to_felt252,
    };

    #[storage]
    struct Storage {
        escrows: Map<felt252, Escrow>,
    }

    #[event]
    #[derive(Copy, Drop, Debug, PartialEq, starknet::Event)]
    pub enum Event {
        DstEscrowCreated: DstEscrowCreated,
        Withdrawn: Withdrawn,
        Cancelled: Cancelled,
    }

    #[derive(Copy, Drop, Debug, PartialEq, starknet::Event)]
    pub struct DstEscrowCreated {
        #[key]
        pub escrow_id: felt252,
        pub maker: ContractAddress,
        pub taker: ContractAddress,
        pub token: ContractAddress,
        pub amount: u256,
        pub safety_deposit: u256,
        pub hashlock: felt252,
    }

    #[derive(Copy, Drop, Debug, PartialEq, starknet::Event)]
    pub struct Withdrawn {
        #[key]
        pub escrow_id: felt252,
        pub secret: felt252,
    }

    #[derive(Copy, Drop, Debug, PartialEq, starknet::Event)]
    pub struct Cancelled {
        #[key]
        pub escrow_id: felt252,
    }

    #[abi(embed_v0)]
    impl StarknetEscrowImpl of IStarknetEscrow<ContractState> {
        fn create_escrow(
            ref self: ContractState,
            escrow_id: felt252,
            maker: ContractAddress,
            token: ContractAddress,
            amount: u256,
            safety_deposit: u256,
            hashlock: felt252,
            timelocks: Timelocks,
        ) {
            // Assert that an escrow with the given escrow_id does not already exist
            assert(!self.escrow_exists(escrow_id), 'Escrow already exists');

            // Get the caller's address, which will be set as the taker
            let taker = get_caller_address();

            // 1. Transfer the primary swap token (e.g., STRK) from the taker.
            let token_dispatcher = IERC20Dispatcher { contract_address: token };
            assert(
                token_dispatcher.transfer_from(taker, starknet::get_contract_address(), amount),
                'Token transfer failed',
            );

            // 2. Transfer the safety deposit (ETH) from the taker.
            let eth_token_dispatcher = IERC20Dispatcher {
                contract_address: ETH_CONTRACT_ADDRESS.try_into().unwrap(),
            };

            assert(
                eth_token_dispatcher
                    .transfer_from(taker, starknet::get_contract_address(), safety_deposit),
                'Safety deposit transfer failed',
            );

            // Construct a new Escrow object
            let new_escrow = Escrow {
                maker,
                taker,
                token,
                amount,
                safety_deposit,
                hashlock,
                timelocks,
                status: EscrowStatus::Active,
            };

            // Write the new Escrow object into the escrows map
            self.escrows.write(escrow_id, new_escrow);

            // Emit DstEscrowCreated event
            self
                .emit(
                    Event::DstEscrowCreated(
                        DstEscrowCreated {
                            escrow_id,
                            maker,
                            taker,
                            token,
                            amount,
                            safety_deposit,
                            hashlock,
                        },
                    ),
                );
        }

        fn withdraw(ref self: ContractState, escrow_id: felt252, secret: felt252) {
            // Read the Escrow data from storage using the escrow_id
            let mut escrow = self.escrows.read(escrow_id);

            // Assert that the escrow exists (status should not be uninitialized)
            assert(escrow.status == EscrowStatus::Active, 'Escrow not active');

            // Assert that the current block timestamp is greater than or equal to
            // timelocks.withdrawal
            let current_time = get_block_timestamp();
            assert(current_time >= escrow.timelocks.withdrawal, 'Withdrawal period not started');

            // Compute the keccak256 hash of the provided secret to match EVM behavior
            let computed_hash: felt252 = keccak_felt252_to_felt252(secret);

            // Assert that the computed hash matches the stored hashlock
            assert(computed_hash == escrow.hashlock, 'Invalid secret');

            // Extract values before modifying escrow
            let token_address = escrow.token;
            let maker_address = escrow.maker;
            let taker_address = escrow.taker;
            let amount = escrow.amount;
            let safety_deposit = escrow.safety_deposit;

            // Update the escrow status to Withdrawn
            escrow.status = EscrowStatus::Withdrawn;
            self.escrows.write(escrow_id, escrow);

            // Transfer the amount of token to the maker
            let token_dispatcher = IERC20Dispatcher { contract_address: token_address };
            assert(token_dispatcher.transfer(maker_address, amount), 'Transfer to maker failed');

            // Transfer the safety_deposit (ETH) back to the taker
            let eth_token_dispatcher = IERC20Dispatcher {
                contract_address: ETH_CONTRACT_ADDRESS.try_into().unwrap(),
            };
            assert(
                eth_token_dispatcher.transfer(taker_address, safety_deposit),
                'Safety deposit transfer failed',
            );

            // Emit Withdrawn event
            self.emit(Event::Withdrawn(Withdrawn { escrow_id, secret }));
        }

        fn cancel(ref self: ContractState, escrow_id: felt252) {
            // Read the Escrow data from storage using the escrow_id
            let mut escrow = self.escrows.read(escrow_id);

            // Assert that the caller is the maker
            let caller = get_caller_address();
            assert(caller == escrow.maker, 'Only maker can cancel');

            // Assert that the escrow status is Active
            assert(escrow.status == EscrowStatus::Active, 'Escrow not active');

            // Assert that the current block timestamp is greater than or equal to
            // timelocks.cancellation
            let current_time = get_block_timestamp();
            assert(
                current_time >= escrow.timelocks.cancellation, 'Cancellation period not started',
            );

            // Extract values before modifying escrow
            let token_address = escrow.token;
            let maker_address = escrow.maker;
            let amount = escrow.amount;
            let safety_deposit = escrow.safety_deposit;

            // Update the escrow status to Cancelled
            escrow.status = EscrowStatus::Cancelled;
            self.escrows.write(escrow_id, escrow);

            // Transfer the amount and the safety_deposit to the maker
            let token_dispatcher = IERC20Dispatcher { contract_address: token_address };
            assert(
                token_dispatcher.transfer(maker_address, amount), 'Token refund failed',
            );
            
            // Transfer the safety deposit (ETH) to the maker
            let eth_token_dispatcher = IERC20Dispatcher {
                contract_address: ETH_CONTRACT_ADDRESS.try_into().unwrap(),
            };
            assert(
                eth_token_dispatcher.transfer(maker_address, safety_deposit), 'ETH refund failed',
            );

            // Emit Cancelled event
            self.emit(Event::Cancelled(Cancelled { escrow_id }));
        }

        fn get_escrow(self: @ContractState, escrow_id: felt252) -> Escrow {
            self.escrows.read(escrow_id)
        }

        fn escrow_exists(self: @ContractState, escrow_id: felt252) -> bool {
            let escrow = self.escrows.read(escrow_id);
            // Check if escrow status is not uninitialized
            escrow.status != EscrowStatus::Uninitialized
        }
    }

    #[generate_trait]
    impl InternalFunctions of InternalFunctionsTrait {
        fn _is_escrow_initialized(self: @ContractState, escrow_id: felt252) -> bool {
            let escrow = self.escrows.read(escrow_id);
            // Check if any core field is set to determine if escrow exists
            escrow.maker.is_non_zero() || escrow.taker.is_non_zero() || escrow.token.is_non_zero()
        }
    }
}

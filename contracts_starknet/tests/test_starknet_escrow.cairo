use starknet::{ContractAddress, contract_address_const, get_block_timestamp};
use snforge_std::{declare, ContractClassTrait, DeclareResultTrait, start_cheat_caller_address, stop_cheat_caller_address};
use contracts_starknet::starknet_escrow::{
    IStarknetEscrowDispatcher, IStarknetEscrowDispatcherTrait,
    Timelocks, EscrowStatus
};
use contracts_starknet::mock_erc20::{
    IMockERC20Dispatcher, IMockERC20DispatcherTrait
};
use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use core::poseidon::PoseidonTrait;
use core::hash::{HashStateTrait, HashStateExTrait};

fn deploy_mock_token() -> IMockERC20Dispatcher {
    let contract = declare("MockERC20").unwrap().contract_class();
    let name: felt252 = 'MockToken';
    let symbol: felt252 = 'MTK';
    let decimals: u8 = 18;
    let initial_supply: u256 = 0;
    let recipient = contract_address_const::<'recipient'>();
    let (contract_address, _) = contract.deploy(@array![name, symbol, decimals.into(), initial_supply.low.into(), initial_supply.high.into(), recipient.into()]).unwrap();
    IMockERC20Dispatcher { contract_address }
}

fn deploy_starknet_escrow() -> IStarknetEscrowDispatcher {
    let contract = declare("StarknetEscrow").unwrap().contract_class();
    let (contract_address, _) = contract.deploy(@array![]).unwrap();
    IStarknetEscrowDispatcher { contract_address }
}

#[test]
fn test_create_escrow() {
    let escrow = deploy_starknet_escrow();
    let token = deploy_mock_token();
    
    let maker: ContractAddress = contract_address_const::<'maker'>();
    let taker: ContractAddress = contract_address_const::<'taker'>();
    let amount: u256 = 1000;
    let safety_deposit: u256 = 100;
    let secret: felt252 = 'secret123';
    let hashlock_starknet = PoseidonTrait::new().update_with(secret).finalize();
    
    let current_time = get_block_timestamp();
    let timelocks = Timelocks {
        withdrawal: current_time + 3600, // 1 hour from now
        public_withdrawal: current_time + 7200, // 2 hours from now
        cancellation: current_time + 86400, // 24 hours from now
    };
    
    let escrow_id: felt252 = 'test_escrow_1';
    
    // Mint tokens to taker
    start_cheat_caller_address(token.contract_address, maker);
    token.mint(taker, amount + safety_deposit);
    stop_cheat_caller_address(token.contract_address);
    
    // Approve escrow contract to spend tokens
    start_cheat_caller_address(token.contract_address, taker);
    token.approve(escrow.contract_address, amount + safety_deposit);
    stop_cheat_caller_address(token.contract_address);
    
    // Create escrow as taker
    start_cheat_caller_address(escrow.contract_address, taker);
    escrow.create_escrow(
        escrow_id,
        maker,
        token.contract_address,
        amount,
        safety_deposit,
        hashlock_starknet,
        timelocks
    );
    stop_cheat_caller_address(escrow.contract_address);
    
    // Verify escrow exists
    assert(escrow.escrow_exists(escrow_id), 'Escrow should exist');
    
    // Verify escrow data
    let stored_escrow = escrow.get_escrow(escrow_id);
    assert(stored_escrow.maker == maker, 'Maker mismatch');
    assert(stored_escrow.taker == taker, 'Taker mismatch');
    assert(stored_escrow.token == token.contract_address, 'Token mismatch');
    assert(stored_escrow.amount == amount, 'Amount mismatch');
    assert(stored_escrow.safety_deposit == safety_deposit, 'Safety deposit mismatch');
    assert(stored_escrow.hashlock_starknet == hashlock_starknet, 'Hashlock mismatch');
    assert(stored_escrow.status == EscrowStatus::Active, 'Status should be Active');
}

#[test]
#[should_panic(expected: ('Escrow already exists',))]
fn test_create_escrow_duplicate() {
    let escrow = deploy_starknet_escrow();
    let token = deploy_mock_token();
    
    let maker: ContractAddress = contract_address_const::<'maker'>();
    let taker: ContractAddress = contract_address_const::<'taker'>();
    let amount: u256 = 1000;
    let safety_deposit: u256 = 100;
    let secret: felt252 = 'secret123';
    let hashlock_starknet = PoseidonTrait::new().update_with(secret).finalize();
    
    let current_time = get_block_timestamp();
    let timelocks = Timelocks {
        withdrawal: current_time + 3600,
        public_withdrawal: current_time + 7200,
        cancellation: current_time + 86400,
    };
    
    let escrow_id: felt252 = 'test_escrow_1';
    
    // Mint tokens to taker
    start_cheat_caller_address(token.contract_address, maker);
    token.mint(taker, (amount + safety_deposit) * 2);
    stop_cheat_caller_address(token.contract_address);
    
    // Approve escrow contract to spend tokens
    start_cheat_caller_address(token.contract_address, taker);
    token.approve(escrow.contract_address, (amount + safety_deposit) * 2);
    stop_cheat_caller_address(token.contract_address);
    
    // Create escrow as taker
    start_cheat_caller_address(escrow.contract_address, taker);
    escrow.create_escrow(
        escrow_id,
        maker,
        token.contract_address,
        amount,
        safety_deposit,
        hashlock_starknet,
        timelocks
    );
    
    // Try to create the same escrow again - should panic
    escrow.create_escrow(
        escrow_id,
        maker,
        token.contract_address,
        amount,
        safety_deposit,
        hashlock_starknet,
        timelocks
    );
    stop_cheat_caller_address(escrow.contract_address);
}

#[test]
fn test_escrow_exists_false_for_nonexistent() {
    let escrow = deploy_starknet_escrow();
    let escrow_id: felt252 = 'nonexistent';
    
    assert(!escrow.escrow_exists(escrow_id), 'Escrow should not exist');
}

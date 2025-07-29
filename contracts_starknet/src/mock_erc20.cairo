// Simple mock ERC20 for testing - minimal implementation
#[starknet::interface]
pub trait IMockERC20<TContractState> {
    fn name(self: @TContractState) -> felt252;
    fn symbol(self: @TContractState) -> felt252;
    fn total_supply(self: @TContractState) -> u256;
    fn transfer(ref self: TContractState, to: starknet::ContractAddress, amount: u256) -> bool;
    fn approve(ref self: TContractState, spender: starknet::ContractAddress, amount: u256) -> bool;
    fn transfer_from(ref self: TContractState, from: starknet::ContractAddress, to: starknet::ContractAddress, amount: u256) -> bool;
    fn allowance(self: @TContractState, owner: starknet::ContractAddress, spender: starknet::ContractAddress) -> u256;
    
    // Mock-specific functions for testing
    fn mint(ref self: TContractState, to: starknet::ContractAddress, amount: u256);
    fn get_balance(self: @TContractState, account: starknet::ContractAddress) -> u256;
    fn set_balance(ref self: TContractState, account: starknet::ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockERC20 {
    use starknet::ContractAddress;
    use starknet::get_caller_address;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        name: felt252,
        symbol: felt252,
        total_supply: u256,
        // Simplified storage for testing - using two balance slots
        balance_1: u256,
        address_1: ContractAddress,
        balance_2: u256,
        address_2: ContractAddress,
        // Simple allowance storage - for testing we'll just store one allowance
        allowance_owner: ContractAddress,
        allowance_spender: ContractAddress,
        allowance_amount: u256,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        Transfer: Transfer,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Transfer {
        #[key]
        pub from: ContractAddress,
        #[key] 
        pub to: ContractAddress,
        pub value: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: felt252,
        symbol: felt252,
        decimals: u8, // ignored for simplicity
        initial_supply: u256,
        recipient: ContractAddress
    ) {
        self.name.write(name);
        self.symbol.write(symbol);
        self.total_supply.write(initial_supply);
        self.balance_1.write(initial_supply);
        self.address_1.write(recipient);
        self.balance_2.write(0);
        self.address_2.write(0.try_into().unwrap());
        
        self.emit(Event::Transfer(Transfer {
            from: 0.try_into().unwrap(),
            to: recipient,
            value: initial_supply
        }));
    }

    #[abi(embed_v0)]
    impl MockERC20Impl of super::IMockERC20<ContractState> {
        fn name(self: @ContractState) -> felt252 {
            self.name.read()
        }

        fn symbol(self: @ContractState) -> felt252 {
            self.symbol.read()
        }

        fn total_supply(self: @ContractState) -> u256 {
            self.total_supply.read()
        }

        fn transfer(ref self: ContractState, to: ContractAddress, amount: u256) -> bool {
            let from = get_caller_address();
            let from_balance = self.get_balance(from);
            assert(from_balance >= amount, 'Insufficient balance');
            
            // Update sender balance
            self.set_balance(from, from_balance - amount);
            
            // Update recipient balance
            let to_balance = self.get_balance(to);
            self.set_balance(to, to_balance + amount);
            
            self.emit(Event::Transfer(Transfer {
                from,
                to,
                value: amount
            }));
            true
        }

        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            let current_supply = self.total_supply.read();
            let current_balance = self.get_balance(to);
            
            self.total_supply.write(current_supply + amount);
            self.set_balance(to, current_balance + amount);
            
            self.emit(Event::Transfer(Transfer {
                from: 0.try_into().unwrap(),
                to,
                value: amount
            }));
        }

        fn get_balance(self: @ContractState, account: ContractAddress) -> u256 {
            // Check both address slots
            if account == self.address_1.read() {
                self.balance_1.read()
            } else if account == self.address_2.read() {
                self.balance_2.read()
            } else {
                0
            }
        }

        fn set_balance(ref self: ContractState, account: ContractAddress, amount: u256) {
            // Try to use existing slots first
            if account == self.address_1.read() {
                self.balance_1.write(amount);
            } else if account == self.address_2.read() {
                self.balance_2.write(amount);
            } else {
                // Use the first available slot
                if self.address_1.read() == 0.try_into().unwrap() {
                    self.address_1.write(account);
                    self.balance_1.write(amount);
                } else {
                    self.address_2.write(account);
                    self.balance_2.write(amount);
                }
            }
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            let owner = get_caller_address();
            self.allowance_owner.write(owner);
            self.allowance_spender.write(spender);
            self.allowance_amount.write(amount);
            true
        }

        fn transfer_from(ref self: ContractState, from: ContractAddress, to: ContractAddress, amount: u256) -> bool {
            let spender = get_caller_address();
            let current_allowance = self.allowance(from, spender);
            assert(current_allowance >= amount, 'Insufficient allowance');
            
            let from_balance = self.get_balance(from);
            assert(from_balance >= amount, 'Insufficient balance');
            
            // Update balances
            self.set_balance(from, from_balance - amount);
            let to_balance = self.get_balance(to);
            self.set_balance(to, to_balance + amount);
            
            // Update allowance
            if current_allowance != 0xffffffffffffffffffffffffffffffff { // not max allowance
                self.allowance_amount.write(current_allowance - amount);
            }
            
            self.emit(Event::Transfer(Transfer {
                from,
                to,
                value: amount
            }));
            true
        }

        fn allowance(self: @ContractState, owner: ContractAddress, spender: ContractAddress) -> u256 {
            if owner == self.allowance_owner.read() && spender == self.allowance_spender.read() {
                self.allowance_amount.read()
            } else {
                0
            }
        }
    }
}

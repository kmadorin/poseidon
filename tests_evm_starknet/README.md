# EVM-to-StarkNet Cross-Chain Swap Implementation

This directory contains the implementation of cross-chain swaps between EVM chains and StarkNet, based on the plan outlined in `EVM_STARKNET_SWAP_IMPLEMENTATION_PLAN.md`.

## Directory Structure

```
tests_evm_starknet/
├── .env                     # Environment configuration
├── README.md               # This file
├── main.spec.ts            # Main test file for EVM-StarkNet swap
├── helpers/
│   ├── evm-helpers.ts      # EVM blockchain interaction helpers
│   └── starknet-helpers.ts # StarkNet blockchain interaction helpers
└── scripts/
    └── deploy-starknet.ts  # StarkNet contract deployment script
```

## Prerequisites

Before running the tests, ensure you have the following installed:

- Node.js (>= 22)
- pnpm
- Foundry (for Anvil)
- starknet-devnet
- The Scarb toolchain for compiling Cairo contracts

## Setup

1. **Install dependencies** (from project root):
   ```bash
   pnpm install
   ```

2. **Compile StarkNet contracts**:
   ```bash
   cd contracts_starknet
   scarb build
   cd ..
   ```

3. **Configure environment variables**:
   
   Update `tests_evm_starknet/.env` with the appropriate values:
   - EVM configuration is pre-filled with Anvil defaults
   - StarkNet addresses need to be obtained from starknet-devnet startup logs

## Usage

### Running the Full Test Suite

To run the complete EVM-to-StarkNet swap test:

```bash
pnpm run test:evm-starknet
```

This will:
1. Start Anvil (EVM local node)
2. Start StarkNet Devnet
3. Deploy necessary contracts
4. Execute the cross-chain swap flow
5. Verify the results

### Manual Contract Deployment

To deploy just the StarkNet contracts:

```bash
pnpm run deploy:starknet
```

## Test Flow

The main test (`main.spec.ts`) follows this flow:

1. **Environment Setup**: Start Anvil and StarkNet Devnet
2. **Account Initialization**: Set up maker and resolver accounts on both chains
3. **Order Creation**: Generate cross-chain order with hash locks
4. **EVM Fulfillment**: Deploy source escrow on EVM chain
5. **StarkNet Fulfillment**: Create escrow on StarkNet
6. **Fund Claims**: 
   - Maker claims funds on StarkNet using secret
   - Resolver claims funds on EVM using revealed secret
7. **Verification**: Check final balances on both chains

## Key Components

### EVM Helpers (`helpers/evm-helpers.ts`)

- `getEVMProvider()`: Creates JsonRpcProvider for EVM chain
- `getMakerWallet()`, `getResolverWallet()`: Wallet instances
- `getResolver()`: Resolver contract interface

### StarkNet Helpers (`helpers/starknet-helpers.ts`)

- `getStarknetProvider()`: Creates RpcProvider for StarkNet
- `getMakerAccount()`, `getResolverAccount()`: Account instances
- `getEscrowContract()`: Escrow contract interface
- `fundStarknetAccount()`: Funds accounts on devnet

### Deployment Script (`scripts/deploy-starknet.ts`)

Handles:
- Contract declaration on StarkNet
- Contract deployment
- Saving deployment information for later use

## Environment Variables

### EVM Configuration
- `EVM_RPC_URL`: RPC endpoint for EVM chain (default: Anvil)
- `MAKER_PRIVATE_KEY`: Private key for maker account
- `RESOLVER_PRIVATE_KEY`: Private key for resolver account

### StarkNet Configuration
- `STARKNET_RPC_URL`: RPC endpoint for StarkNet (default: devnet)
- `MAKER_STARKNET_ADDRESS`: StarkNet address for maker
- `MAKER_STARKNET_PRIVATE_KEY`: Private key for StarkNet maker
- `RESOLVER_STARKNET_ADDRESS`: StarkNet address for resolver  
- `RESOLVER_STARKNET_PRIVATE_KEY`: Private key for StarkNet resolver

## Notes

- This implementation is for testing and educational purposes
- The test uses local devnets (Anvil and starknet-devnet)
- StarkNet account addresses need to be manually obtained from devnet logs
- The implementation follows the atomic swap pattern with hash time-locked contracts

## Troubleshooting

1. **Port conflicts**: Ensure ports 8545 (Anvil) and 5050 (StarkNet devnet) are available
2. **StarkNet accounts**: Update `.env` with actual devnet account addresses and private keys
3. **Contract compilation**: Ensure Scarb is properly installed and contracts compile successfully
4. **Dependencies**: Run `pnpm install` to ensure all dependencies are installed

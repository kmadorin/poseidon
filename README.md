# Poseidon. 1inch fusion+ protocol extension Starknet

## Installation

Install example deps

```shell
pnpm install
```

Install [foundry](https://book.getfoundry.sh/getting-started/installation)

```shell
curl -L https://foundry.paradigm.xyz | bash
```

Install [starknet-foundry](https://foundry-rs.github.io/starknet-foundry/getting-started/installation.html)

```shell
asdf plugin add scarb

asdf install scarb latest

asdf set --home scarb latest

```

To verify that Scarb was installed, run:

```shell
scarb --version
```

Install [starknet-devnet](https://0xspaceshard.github.io/starknet-devnet/docs/running/install). Anvil analogue on Starknet:

From crates.io:

```shell
cargo install starknet-devnet
```

Or using asdf:

```shell
asdf plugin add starknet-devnet
asdf install starknet-devnet latest
```

Install contract deps

```shell
forge install
```

Populate env:

```shell
cp .env.example .env
cd tests_evm_starknet && cp .env.example .env
```

Build contracts:

```shell
forge build
cd contracts_starknet && scarb build
```

## Running

Run EVM <-> Starknet swap test:

```shell
pnpm run test:evm-starknet
```

### Public rpc used in .env.example:

| Chain    | Url                                                  |
| -------- | ---------------------------------------------------- |
| Ethereum | https://eth.merkle.io                                |
| Starknet | https://starknet-mainnet.public.blastapi.io/rpc/v0_8 |

## EVM -> Starknet swap steps (USDC on EVM to ETH on Starknet):

1. Alice(Maker) creates and signs limit order on EVM chain and publishes to Bob(Resolver)
2. Bob atomically deploys Hash Timelocked Escrow on EVM chain and fills the limit order on EVM
3. Bob creates and funds Escrow on the destination chain with the same hash and smaller timelock
   On steps 2 and 3 Bob also provides a security deposit as an incentive for other resolvers to complete the swap anyway, after both timelocks will be expired
4. Alice reveals the secret on Starknet to get maker amount of STRK via withdraw call of Starknet escrow contract
5. Bob listens to withdraw events and once a withdrawal occurs, he gets the secret to get maker amount on EVM chain.
6. Bob gets maker amount on the EVM chain (swap completed)

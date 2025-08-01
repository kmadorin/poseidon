// tests_evm_starknet/main.spec.ts
import 'dotenv/config'
import {expect, jest} from '@jest/globals'
import {exec, execSync, spawn, ChildProcess} from 'child_process'
import {JsonRpcProvider, Wallet as SignerWallet, randomBytes, hexlify, keccak256} from 'ethers'
import {hash, Contract, cairo, CallData} from 'starknet'
import Sdk from '@1inch/cross-chain-sdk'
import {uint8ArrayToHex} from '@1inch/byte-utils'
import path from 'path'
import {fileURLToPath} from 'url'
import {dirname} from 'path'

// Load env vars from the correct path
import dotenv from 'dotenv'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Load both the root .env and the test-specific .env
dotenv.config({path: path.resolve(__dirname, '../.env')}) // Root .env first
dotenv.config({path: path.resolve(__dirname, './.env')}) // Test .env second (overrides)

import {
    fundStarknetAccount,
    getMakerAccount,
    getResolverAccount,
    getEscrowContract,
    getStarknetProvider,
    compileAndDeployStarknetContract
} from './helpers/starknet-helpers'
import {deployEvmContracts, topUpFromDonor} from './helpers/evm-helpers'
import {Wallet} from '../tests/wallet'
import {Resolver} from '../tests/resolver'
import {EscrowFactory} from '../tests/escrow-factory'
import {config as evmConfig} from '../tests/config'

jest.setTimeout(1000 * 300) // 5 minutes timeout for cross-chain tests including StarkNet deployment

describe('EVM-to-StarkNet Swap', () => {
    let anvil: ChildProcess
    let starknetDevnet: ChildProcess
    let escrowContractAddress: string

    beforeAll(async () => {
        console.log('Starting Anvil with mainnet fork...')
        const mainnetRpc = process.env.SRC_CHAIN_RPC
        if (!mainnetRpc) {
            throw new Error('SRC_CHAIN_RPC not found in environment variables')
        }
        console.log(`Forking from: ${mainnetRpc}`)
        anvil = spawn('bash', ['-c', `anvil --fork-url ${mainnetRpc}`], {stdio: 'pipe'})

        console.log('Starting StarkNet Devnet...')
        starknetDevnet = spawn('bash', ['-c', 'starknet-devnet --seed 0'], {stdio: 'pipe'})

        // A more robust wait for services to be ready
        await new Promise((resolve) => setTimeout(resolve, 8000))
        console.log('Devnets should be running.')

        console.log('Funding StarkNet accounts...')
        await fundStarknetAccount(process.env.MAKER_STARKNET_ADDRESS!, 100n * 10n ** 18n, 'WEI') // 100 ETH
        await fundStarknetAccount(process.env.RESOLVER_STARKNET_ADDRESS!, 100n * 10n ** 18n, 'WEI') // 100 ETH

        console.log('Compiling and deploying StarkNet contract...')
        escrowContractAddress = await compileAndDeployStarknetContract()
    })

    afterAll(() => {
        console.log('Stopping devnets...')
        anvil.kill()
        starknetDevnet.kill()
    })

    it('should perform a successful EVM to StarkNet cross-chain swap', async () => {
        // 1. Initialize providers and wallets
        const evmProvider = new JsonRpcProvider(process.env.EVM_RPC_URL!)
        const makerEvmWallet = new Wallet(process.env.MAKER_PRIVATE_KEY!, evmProvider)
        const resolverEvmWallet = new Wallet(process.env.RESOLVER_PRIVATE_KEY!, evmProvider)

        const starknetProvider = getStarknetProvider()
        const makerStarknetAccount = getMakerAccount(starknetProvider)
        const resolverStarknetAccount = getResolverAccount(starknetProvider)
        const starknetEscrow = getEscrowContract(starknetProvider, escrowContractAddress)

        // Deploy EVM contracts
        const {escrowFactoryAddress, resolverAddress} = await deployEvmContracts(
            evmProvider,
            process.env.MAKER_PRIVATE_KEY!,
            process.env.RESOLVER_PRIVATE_KEY!
        )

        // Fund accounts efficiently to avoid nonce conflicts
        const usdcAddress = evmConfig.chain.source.tokens.USDC.address
        const makerInitialUsdcAmount = 1000n * 10n ** 6n // 1000 USDC

        // Use Anvil's pre-funded account to fund both maker and resolver
        const anvilAccount = new SignerWallet(
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            evmProvider
        )
        const donorAddress = evmConfig.chain.source.tokens.USDC.donor

        // Get base nonce for anvilAccount to manage multiple transactions properly
        const anvilBaseNonce = await evmProvider.getTransactionCount(anvilAccount.address)

        // Fund donor with ETH for gas (nonce: base + 0)
        const fundDonorTx = await anvilAccount.sendTransaction({
            to: donorAddress,
            value: 10n ** 18n, // 1 ETH for gas
            nonce: anvilBaseNonce
        })
        await fundDonorTx.wait()

        // Fund resolver with ETH for gas fees and safety deposits (nonce: base + 1)
        const fundResolverTx = await anvilAccount.sendTransaction({
            to: await resolverEvmWallet.getAddress(),
            value: 10n ** 18n, // 1 ETH
            nonce: anvilBaseNonce + 1
        })
        await fundResolverTx.wait()

        // Use the donor to fund both accounts with USDC (ensure transactions are sequential)
        const donorWallet = await Wallet.fromAddress(donorAddress, evmProvider)
        await donorWallet.transferToken(usdcAddress, await makerEvmWallet.getAddress(), makerInitialUsdcAmount)
        await donorWallet.transferToken(usdcAddress, await resolverEvmWallet.getAddress(), makerInitialUsdcAmount)

        // IMPORTANT: Fund the resolver CONTRACT with USDC (not just the resolver wallet)
        await donorWallet.transferToken(usdcAddress, resolverAddress, makerInitialUsdcAmount * 2n)

        // Fund resolver contract with ETH for gas (nonce: base + 2)
        const fundResolverContractEthTx = await anvilAccount.sendTransaction({
            to: resolverAddress,
            value: 10n ** 18n, // 1 ETH
            nonce: anvilBaseNonce + 2
        })
        await fundResolverContractEthTx.wait()

        // Get resolver contract wallet and approve escrow factory
        const resolverContractWallet = await Wallet.fromAddress(resolverAddress, evmProvider)
        await resolverContractWallet.approveToken(usdcAddress, escrowFactoryAddress, makerInitialUsdcAmount * 2n)

        // Approve tokens to LimitOrderProtocol (not resolver directly)
        await makerEvmWallet.approveToken(
            usdcAddress,
            evmConfig.chain.source.limitOrderProtocol,
            makerInitialUsdcAmount
        )

        // Add a small delay to ensure all funding transactions are processed
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // 2. Phase 1: Order Creation (Off-chain)
        console.log('Debug - Sdk object:', typeof Sdk, Sdk ? Object.keys(Sdk).slice(0, 10) : 'null')
        console.log('Debug - CrossChainOrder available:', !!Sdk.CrossChainOrder)
        console.log('Debug - NetworkEnum:', Sdk.NetworkEnum ? Object.keys(Sdk.NetworkEnum) : 'undefined')

        const secret = randomBytes(32)
        const secretPart1Bytes = secret.slice(0, 16)
        const secretPart2Bytes = secret.slice(16, 32)

        // 2. Convert each part to a hex string for the calldata
        const secretPart1Hex = hexlify(secretPart1Bytes)
        const secretPart2Hex = hexlify(secretPart2Bytes)

        const hashLock = keccak256(secret)
        // Use the same keccak256 hash for both EVM and Starknet to prevent maker from using different pre-images

        // Create order with a supported chain ID first (using BSC as destination)
        const order = Sdk.CrossChainOrder.new(
            new Sdk.Address(escrowFactoryAddress),
            {
                salt: Sdk.randBigInt(1000n),
                maker: new Sdk.Address(await makerEvmWallet.getAddress()),
                makingAmount: makerInitialUsdcAmount,
                takingAmount: 1n * 10n ** 18n, // 1 STRK (example)
                makerAsset: new Sdk.Address(usdcAddress),
                takerAsset: new Sdk.Address(
                    '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'.slice(0, 42)
                ) // Truncate to EVM address format
            },
            {
                hashLock: Sdk.HashLock.forSingleFill(uint8ArrayToHex(secret)),
                timeLocks: Sdk.TimeLocks.new({
                    srcWithdrawal: 10n, // 10sec finality lock for test
                    srcPublicWithdrawal: 120n, // 2m for private withdrawal
                    srcCancellation: 121n, // 1sec public withdrawal
                    srcPublicCancellation: 122n, // 1sec private cancellation
                    dstWithdrawal: 10n, // 10sec finality lock for test
                    dstPublicWithdrawal: 100n, // 100sec private withdrawal
                    dstCancellation: 101n // 1sec public withdrawal
                }),
                srcChainId: evmConfig.chain.source.chainId,
                dstChainId: 56, // Use BSC (supported chain ID)
                srcSafetyDeposit: 10n ** 15n,
                dstSafetyDeposit: 10n ** 15n
            },
            {
                auction: new Sdk.AuctionDetails({
                    initialRateBump: 0,
                    points: [],
                    duration: 120n,
                    startTime: BigInt(Math.floor(Date.now() / 1000))
                }),
                whitelist: [
                    {
                        address: new Sdk.Address(resolverAddress),
                        allowFrom: 0n
                    }
                ],
                resolvingStartTime: 0n
            },
            {
                nonce: Sdk.randBigInt(1000n),
                allowPartialFills: false,
                allowMultipleFills: false
            }
        )

        // Manually override the destination chain ID for StarkNet by directly modifying the object
        // This is a hack but necessary since the SDK doesn't support arbitrary chain IDs
        ;(order as any).extension.dstChainId = 1337n

        const signature = await makerEvmWallet.signOrder(evmConfig.chain.source.chainId, order)

        // 3. Phase 2: Order Fulfillment on EVM (On-chain)
        const resolver = new Resolver(resolverAddress, resolverAddress)
        const deploySrcTx = resolver.deploySrc(
            evmConfig.chain.source.chainId,
            order,
            signature,
            Sdk.TakerTraits.default()
                .setExtension(order.extension)
                .setAmountMode(Sdk.AmountMode.maker)
                .setAmountThreshold(order.takingAmount),
            order.makingAmount
        )

        // Debug the transaction before sending
        console.log('Transaction to send:')
        console.log('  To:', deploySrcTx.to)
        console.log('  Data:', deploySrcTx.data)
        console.log('  Data length:', deploySrcTx.data?.length)
        console.log('  Value:', deploySrcTx.value?.toString())

        const {blockHash: evmBlockHash} = await resolverEvmWallet.send(deploySrcTx)

        // Get the full block details to find its timestamp
        const evmBlock = await evmProvider.getBlock(evmBlockHash)
        if (!evmBlock) {
            throw new Error(`Failed to get block ${evmBlockHash}`)
        }
        const deployedAt = BigInt(evmBlock.timestamp) // Convert to BigInt for compatibility

        const escrowSrcDeploymentEvent = await new EscrowFactory(evmProvider, escrowFactoryAddress).getSrcDeployEvent(
            evmBlockHash
        )

        const immutables = escrowSrcDeploymentEvent[0]

        console.log('immutables: ', immutables)

        const dstTimeLocks = immutables.timeLocks.toDstTimeLocks(deployedAt)

        console.log('dstTimeLocks: ', dstTimeLocks)

        // 4. Phase 3: Order Fulfillment on StarkNet (On-chain)

        // First, mint STRK tokens to the resolver account on devnet
        // The STRK token address on devnet is a pre-deployed ERC20 mock
        const strkTokenAddress = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
        const ethTokenAddress = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'

        // Mint STRK tokens using devnet_mint JSON-RPC method
        const mintAmount = order.takingAmount
        // Convert to regular number if small enough, otherwise use scientific notation
        const mintAmountNum = Number(mintAmount)
        const mintBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'devnet_mint',
            params: {
                address: resolverStarknetAccount.address,
                amount: mintAmountNum, // Use number type
                unit: 'FRI' // STRK uses FRI as unit
            }
        })

        const mintResponse = await fetch(process.env.STARKNET_RPC_URL!, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: mintBody
        })

        const mintResult = await mintResponse.json()
        if (mintResult.error) {
            console.log('Failed to mint STRK tokens:', mintResult.error)
        } else {
            console.log(`✅ Minted ${mintAmount} STRK tokens to resolver`)
        }

        // Also mint ETH for safety deposit
        const ethMintAmount = Number(10n ** 15n)
        const ethMintBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'devnet_mint',
            params: {
                address: resolverStarknetAccount.address,
                amount: ethMintAmount, // Use number type
                unit: 'WEI' // ETH uses WEI as unit
            }
        })

        const ethMintResponse = await fetch(process.env.STARKNET_RPC_URL!, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: ethMintBody
        })

        const ethMintResult = await ethMintResponse.json()
        if (ethMintResult.error) {
            console.log('Failed to mint ETH:', ethMintResult.error)
        } else {
            console.log(`✅ Minted ETH for safety deposit to resolver`)
        }

        // Use escrow contract address returned from deployment
        console.log(`Using escrow contract at address: ${escrowContractAddress}`)

        // Create contract instances for STRK and ETH tokens
        const strkContract = new Contract(
            [
                {
                    name: 'approve',
                    type: 'function',
                    inputs: [
                        {name: 'spender', type: 'felt'},
                        {name: 'amount', type: 'Uint256'}
                    ],
                    outputs: [{name: 'success', type: 'felt'}]
                },
                {
                    name: 'transfer_from',
                    type: 'function',
                    inputs: [
                        {name: 'sender', type: 'felt'},
                        {name: 'recipient', type: 'felt'},
                        {name: 'amount', type: 'Uint256'}
                    ],
                    outputs: [{name: 'success', type: 'felt'}]
                }
            ],
            strkTokenAddress,
            starknetProvider
        )
        strkContract.connect(resolverStarknetAccount)

        const ethContract = new Contract(
            [
                {
                    name: 'approve',
                    type: 'function',
                    inputs: [
                        {name: 'spender', type: 'felt'},
                        {name: 'amount', type: 'Uint256'}
                    ],
                    outputs: [{name: 'success', type: 'felt'}]
                },
                {
                    name: 'transfer_from',
                    type: 'function',
                    inputs: [
                        {name: 'sender', type: 'felt'},
                        {name: 'recipient', type: 'felt'},
                        {name: 'amount', type: 'Uint256'}
                    ],
                    outputs: [{name: 'success', type: 'felt'}]
                }
            ],
            ethTokenAddress,
            starknetProvider
        )
        ethContract.connect(resolverStarknetAccount)

        // Approve escrow contract to spend tokens
        console.log('Approving escrow contract to spend tokens...')
        const approveStrkCall = strkContract.populate(
            'approve',
            CallData.compile({
                spender: escrowContractAddress,
                amount: cairo.uint256(order.takingAmount)
            })
        )
        const approveStrkTx = await resolverStarknetAccount.execute(approveStrkCall)
        await starknetProvider.waitForTransaction(approveStrkTx.transaction_hash)
        console.log('✅ STRK approval complete')

        const approveEthCall = ethContract.populate(
            'approve',
            CallData.compile({
                spender: escrowContractAddress,
                amount: cairo.uint256(10n ** 15n) // Safety deposit
            })
        )
        const approveEthTx = await resolverStarknetAccount.execute(approveEthCall)
        await starknetProvider.waitForTransaction(approveEthTx.transaction_hash)
        console.log('✅ ETH approval complete')

        starknetEscrow.connect(resolverStarknetAccount)

        // Access the actual timestamp values directly to avoid getter issues
        const timelocks = {
            withdrawal: deployedAt + BigInt((dstTimeLocks as any)._withdrawal),
            public_withdrawal: deployedAt + BigInt((dstTimeLocks as any)._publicWithdrawal),
            cancellation: deployedAt + BigInt((dstTimeLocks as any)._cancellation)
        }

        const orderHash = order.getOrderHash(evmConfig.chain.source.chainId)
        // Convert to StarkNet felt format - ensure it's within felt252 range
        // Truncate to 251 bits to ensure it's within felt252 range (2^251 - 1 is safe)
        const orderHashBigInt = BigInt(orderHash)
        const felt252Max = BigInt('0x800000000000011000000000000000000000000000000000000000000000000') // 2^251
        const orderHashFelt = (orderHashBigInt % felt252Max).toString()
        const createEscrowCall = starknetEscrow.populate(
            'create_escrow',
            CallData.compile({
                escrow_id: orderHashFelt,
                maker: makerStarknetAccount.address,
                token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', // STRK token address
                amount: cairo.uint256(order.takingAmount),
                safety_deposit: cairo.uint256(10n ** 15n), // Use the same safety deposit as defined in the order
                hashlock: hashLock,
                timelocks
            })
        )
        const createEscrowTx = await resolverStarknetAccount.execute(createEscrowCall)
        await starknetProvider.waitForTransaction(createEscrowTx.transaction_hash)
        console.log('✅ Escrow created on StarkNet')

        // 5. Phase 4: Claiming Funds
        // Maker claims on StarkNet
        starknetEscrow.connect(makerStarknetAccount)
        const withdrawStarknetCall = starknetEscrow.populate(
            'withdraw',
            CallData.compile({
                escrow_id: orderHashFelt,
                secret_part1: secretPart1Hex,
                secret_part2: secretPart2Hex
            })
        )
        const withdrawStarknetTx = await makerStarknetAccount.execute(withdrawStarknetCall)
        await starknetProvider.waitForTransaction(withdrawStarknetTx.transaction_hash)
        console.log('✅ Maker withdrew funds on StarkNet')

        // Resolver claims on EVM
        const srcEscrowEvents = await new EscrowFactory(evmProvider, escrowFactoryAddress).getSrcDeployEvent(
            evmBlockHash
        )
        const srcEscrowEvent = srcEscrowEvents[0]

        const ESCROW_SRC_IMPLEMENTATION = await new EscrowFactory(evmProvider, escrowFactoryAddress).getSourceImpl()

        const srcEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(escrowFactoryAddress)).getSrcEscrowAddress(
            srcEscrowEvent,
            ESCROW_SRC_IMPLEMENTATION
        )

        const withdrawEvmTx = resolver.withdraw('src', srcEscrowAddress, uint8ArrayToHex(secret), srcEscrowEvent)
        await resolverEvmWallet.send(withdrawEvmTx)
        console.log('✅ Resolver withdrew funds on EVM')

        // 6. Phase 5: Verification
        const makerFinalUsdc = await makerEvmWallet.tokenBalance(usdcAddress)
        expect(makerFinalUsdc).toBe(0n)

        const resolverFinalUsdc = await resolverEvmWallet.tokenBalance(usdcAddress)
        expect(resolverFinalUsdc).toBe(makerInitialUsdcAmount)

        // Add StarkNet balance checks here once you have a mock ERC20 deployed
    }, 300000) // 5 minute timeout
    // Additional helper test to verify environment setup
    it('should have proper environment setup', async () => {
        expect(process.env.EVM_RPC_URL).toBeDefined()
        expect(process.env.STARKNET_RPC_URL).toBeDefined()
        expect(process.env.MAKER_PRIVATE_KEY).toBeDefined()
        expect(process.env.RESOLVER_PRIVATE_KEY).toBeDefined()

        // Test EVM connection
        const evmProvider = new JsonRpcProvider(process.env.EVM_RPC_URL!)
        const chainId = await evmProvider.getNetwork().then((n) => n.chainId)
        expect(chainId).toBe(1n) // Mainnet fork chain ID

        console.log('Environment setup verified successfully')
    })
})

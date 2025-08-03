// tests_evm_starknet/main.spec.ts
import 'dotenv/config'
import {expect, jest} from '@jest/globals'
import {exec, execSync, spawn, ChildProcess} from 'child_process'
import {JsonRpcProvider, Wallet as SignerWallet, randomBytes, hexlify, keccak256} from 'ethers'
import {hash, Contract, cairo, CallData, config} from 'starknet'
import Sdk from '@1inch/cross-chain-sdk'
import {uint8ArrayToHex} from '@1inch/byte-utils'
import path from 'path'
import {fileURLToPath} from 'url'
import {dirname} from 'path'
import {erc20Abi} from './helpers/erc20'

// Load env vars from the correct path
import dotenv from 'dotenv'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Load both the root .env and the test-specific .env
dotenv.config({path: path.resolve(__dirname, '../.env')}) // Root .env first
dotenv.config({path: path.resolve(__dirname, './.env')}) // Test .env second (overrides)

import {
    fundStarknetAccount,
    getMakerAccount as getAliceAccount,
    getResolverAccount as getBobAccount,
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

describe('EVM-to-StarkNet Cross-Chain Swap Demo', () => {
    let anvil: ChildProcess
    let starknetDevnet: ChildProcess

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

        console.log('📋 Funding Alice and Bob accounts on Starknet...')
        // await fundStarknetAccount(process.env.MAKER_STARKNET_ADDRESS!, 100n * 10n ** 18n, 'WEI') // 100 ETH for Alice
        await fundStarknetAccount(process.env.RESOLVER_STARKNET_ADDRESS!, 100n * 10n ** 18n, 'WEI') // 100 ETH for Bob
        console.log('✅ SETUP COMPLETE: Accounts funded successfully')
    })

    afterAll(() => {
        console.log('Stopping devnets...')
        anvil.kill()
        starknetDevnet.kill()
    })

    it('should perform a successful EVM to StarkNet cross-chain swap', async () => {
        console.log('\n🎬 STARTING CROSS-CHAIN SWAP DEMO')
        console.log('='.repeat(60))

        // Step 1: Deploy Starknet Escrow Contract
        console.log('\n📦 STEP 1: Deploying Starknet escrow contract...')
        const escrowContractAddress = await compileAndDeployStarknetContract()
        console.log(`✅ Starknet escrow contract deployed at: ${escrowContractAddress}`)

        // Step 2: Initialize wallets and providers
        console.log('\n🔧 STEP 2: Initializing wallets and providers...')
        const evmProvider = new JsonRpcProvider(process.env.EVM_RPC_URL!)
        const aliceEvmWallet = new Wallet(process.env.MAKER_PRIVATE_KEY!, evmProvider) // Alice (maker)
        const bobEvmWallet = new Wallet(process.env.RESOLVER_PRIVATE_KEY!, evmProvider) // Bob (resolver)

        const starknetProvider = getStarknetProvider()
        const aliceStarknetAccount = getAliceAccount(starknetProvider)
        const bobStarknetAccount = getBobAccount(starknetProvider)
        const starknetEscrow = getEscrowContract(starknetProvider, escrowContractAddress)
        console.log(`✅ Alice (maker) EVM wallet: ${await aliceEvmWallet.getAddress()}`)
        console.log(`✅ Bob (resolver) EVM wallet: ${await bobEvmWallet.getAddress()}`)
        console.log(`✅ Alice Starknet account: ${aliceStarknetAccount.address}`)
        console.log(`✅ Bob Starknet account: ${bobStarknetAccount.address}`)

        // Step 3: Deploy EVM contracts
        console.log('\n🏗️ STEP 3: Deploying EVM contracts...')
        const {escrowFactoryAddress, resolverAddress} = await deployEvmContracts(
            evmProvider,
            process.env.MAKER_PRIVATE_KEY!,
            process.env.RESOLVER_PRIVATE_KEY!
        )
        console.log(`✅ EVM escrow factory deployed at: ${escrowFactoryAddress}`)
        console.log(`✅ EVM resolver contract deployed at: ${resolverAddress}`)

        // Step 4: Fund accounts on EVM
        console.log('\n💰 STEP 4: Funding accounts on EVM...')
        const usdcAddress = evmConfig.chain.source.tokens.USDC.address
        const aliceInitialUsdcAmount = 1000n * 10n ** 6n // 1000 USDC for Alice

        // Use Anvil's pre-funded account to fund both Alice and Bob
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
        console.log(`✅ Donor account funded with ETH | Tx: ${fundDonorTx.hash}`)

        // Fund Bob with ETH for gas fees and safety deposits (nonce: base + 1)
        const fundBobTx = await anvilAccount.sendTransaction({
            to: await bobEvmWallet.getAddress(),
            value: 10n ** 18n, // 1 ETH
            nonce: anvilBaseNonce + 1
        })
        await fundBobTx.wait()
        console.log(`✅ Bob funded with ETH for gas fees and safety deposits | Tx: ${fundBobTx.hash}`)

        // Use the donor to fund Alice account with USDC (ensure transactions are sequential)
        const donorWallet = await Wallet.fromAddress(donorAddress, evmProvider)
        const fundAliceUsdcTx = await donorWallet.transferToken(
            usdcAddress,
            await aliceEvmWallet.getAddress(),
            aliceInitialUsdcAmount
        )
        console.log(`✅ Alice funded with ${aliceInitialUsdcAmount / 10n ** 6n} USDC | Tx: ${fundAliceUsdcTx.hash}`)

        // Approve tokens to LimitOrderProtocol (not resolver directly)
        const aliceApproveTx = await aliceEvmWallet.approveToken(
            usdcAddress,
            evmConfig.chain.source.limitOrderProtocol,
            aliceInitialUsdcAmount
        )
        console.log(`✅ Alice approved LimitOrderProtocol | Tx: ${aliceApproveTx.hash}`)

        // Add a small delay to ensure all funding transactions are processed
        await new Promise((resolve) => setTimeout(resolve, 1000))

        // Step 5: Alice creates a limit order (Off-chain)
        console.log('\n📋 STEP 5: Alice creates a limit order...')

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
                maker: new Sdk.Address(await aliceEvmWallet.getAddress()),
                makingAmount: aliceInitialUsdcAmount,
                takingAmount: 1n * 10n ** 18n, // 1 STRK (example)
                makerAsset: new Sdk.Address(usdcAddress),
                takerAsset: new Sdk.Address(
                    '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'.slice(0, 42)
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
                dstChainId: 56, // Use BSC (supported chain ID, will be changed to Starknet later in test)
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

        const signature = await aliceEvmWallet.signOrder(evmConfig.chain.source.chainId, order)
        const orderHash = order.getOrderHash(evmConfig.chain.source.chainId)

        // Display order details
        console.log('✅ Alice created limit order with following details:')
        console.log(`   💰 Maker Amount: ${aliceInitialUsdcAmount / 10n ** 6n} USDC`)
        console.log(`   💰 Taker Amount: ${order.takingAmount / 10n ** 18n} ETH`)
        console.log(`   🔗 Source Chain: Ethereum (${evmConfig.chain.source.chainId})`)
        console.log(`   🔗 Destination Chain: Starknet (1337)`)
        console.log(`   🔒 Order Hash: ${orderHash}`)
        console.log(`   ✍️  Signature: ${signature}`)

        const aliceUSDCBalanceBeforeEscrowSrcDeployment = await aliceEvmWallet.tokenBalance(usdcAddress)

        console.log('aliceUSDCBalanceBeforeEscrowSrcDeployment: ', aliceUSDCBalanceBeforeEscrowSrcDeployment)
        // Step 6: Bob fills the order and creates EscrowSrc contract on EVM with safety deposit
        console.log("\n🔄 STEP 6: Bob fills Alice's order and creates EscrowSrc contract on EVM...")
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

        const result = await bobEvmWallet.send(deploySrcTx)
        const {blockTimestamp: timestamp, txHash, blockHash: evmBlockHash} = result
        console.log(`✅ Bob filled order and created EscrowSrc with safety deposit | txHash: ${txHash}`)

        const aliceUSDCBalanceAfterEscrowSrcDeployment = await aliceEvmWallet.tokenBalance(usdcAddress)
        console.log('aliceUSDCBalanceAfterEscrowSrcDeployment: ', aliceUSDCBalanceAfterEscrowSrcDeployment)
        const deployedAt = BigInt(timestamp) // Convert to BigInt for compatibility

        const escrowSrcDeploymentEvent = await new EscrowFactory(evmProvider, escrowFactoryAddress).getSrcDeployEvent(
            evmBlockHash
        )

        const immutables = escrowSrcDeploymentEvent[0]

        const dstTimeLocks = immutables.timeLocks.toDstTimeLocks(deployedAt)

        // Step 7: Bob creates escrow on Starknet and funds it with safety deposit and taker amount
        console.log('\n🌟 STEP 7: Bob creates escrow on Starknet with safety deposit and taker amount...')

        // First, mint STRK tokens to Bob's account on devnet
        const strkTokenAddress = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
        const ethTokenAddress = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'

        // Mint ETH tokens using devnet_mint JSON-RPC method
        const mintAmount = order.takingAmount
        const mintAmountNum = Number(mintAmount)
        const mintBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'devnet_mint',
            params: {
                address: bobStarknetAccount.address,
                amount: mintAmountNum,
                unit: 'WEI'
            }
        })

        const mintResponse = await fetch(process.env.STARKNET_RPC_URL!, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: mintBody
        })

        const mintResult = await mintResponse.json()
        if (mintResult.error) {
            console.log('❌ Failed to mint STRK tokens:', mintResult.error)
        } else {
            console.log(`✅ Minted ${mintAmount / 10n ** 18n} STRK tokens to Bob`)
        }

        // Also mint ETH for safety deposit
        const ethMintAmount = Number(10n ** 15n)
        const ethMintBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'devnet_mint',
            params: {
                address: bobStarknetAccount.address,
                amount: ethMintAmount,
                unit: 'WEI'
            }
        })

        const ethMintResponse = await fetch(process.env.STARKNET_RPC_URL!, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: ethMintBody
        })

        const ethMintResult = await ethMintResponse.json()
        if (ethMintResult.error) {
            console.log('❌ Failed to mint ETH:', ethMintResult.error)
        } else {
            console.log(`✅ Minted ETH for safety deposit to Bob`)
        }

        // Create contract instances for STRK and ETH tokens
        const strkContract = new Contract(erc20Abi, strkTokenAddress, starknetProvider)
        strkContract.connect(bobStarknetAccount)

        const ethContract = new Contract(erc20Abi, ethTokenAddress, starknetProvider)
        ethContract.connect(bobStarknetAccount)

        const bobEthBalance = await ethContract.balanceOf(bobStarknetAccount.address)
        console.log('bobEthBalance: ', bobEthBalance)

        // Approve escrow contract to spend tokens
        // const approveTakerEthCall = ethContract.populate(
        //     'approve',
        //     CallData.compile({
        //         spender: escrowContractAddress,
        //         amount: cairo.uint256(order.takingAmount)
        //     })
        // )
        // const approveTakerEthTx = await bobStarknetAccount.execute(approveTakerEthCall)
        // await starknetProvider.waitForTransaction(approveTakerEthTx.transaction_hash)
        // console.log(
        //     `✅ Bob approved ${order.takingAmount / 10n ** 18n} ETH | Tx: ${approveTakerEthTx.transaction_hash}`
        // )

        const approveEthCall = ethContract.populate(
            'approve',
            CallData.compile({
                spender: escrowContractAddress,
                amount: cairo.uint256(order.takingAmount + 10n ** 15n) // Safety deposit + taker amount
            })
        )
        const approveEthTx = await bobStarknetAccount.execute(approveEthCall)
        await starknetProvider.waitForTransaction(approveEthTx.transaction_hash)
        console.log(`✅ Bob approved ETH for safety deposit and taker amount | Tx: ${approveEthTx.transaction_hash}`)

        starknetEscrow.connect(bobStarknetAccount)

        // Access the actual timestamp values directly to avoid getter issues
        const timelocks = {
            withdrawal: deployedAt + BigInt((dstTimeLocks as any)._withdrawal),
            public_withdrawal: deployedAt + BigInt((dstTimeLocks as any)._publicWithdrawal),
            cancellation: deployedAt + BigInt((dstTimeLocks as any)._cancellation)
        }

        const orderHashBigInt = BigInt(orderHash)
        const felt252Max = BigInt('0x800000000000011000000000000000000000000000000000000000000000000') // 2^251
        const orderHashFelt = (orderHashBigInt % felt252Max).toString()
        const createEscrowCall = starknetEscrow.populate(
            'create_escrow',
            CallData.compile({
                escrow_id: orderHashFelt,
                maker: aliceStarknetAccount.address,
                token: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', // ETH token address
                amount: cairo.uint256(order.takingAmount),
                safety_deposit: cairo.uint256(10n ** 15n), // Use the same safety deposit as defined in the order
                hashlock: hashLock,
                timelocks
            })
        )
        const createEscrowTx = await bobStarknetAccount.execute(createEscrowCall)
        await starknetProvider.waitForTransaction(createEscrowTx.transaction_hash)
        console.log(
            `✅ Bob created escrow on Starknet with ${order.takingAmount / 10n ** 18n} STRK + safety deposit | Tx: ${createEscrowTx.transaction_hash}`
        )

        // Step 8: Alice reveals the secret on Starknet and gets taker amount
        console.log('\n🔓 STEP 8: Alice reveals the secret on Starknet and receives her taker amount...')
        starknetEscrow.connect(aliceStarknetAccount)
        const withdrawStarknetCall = starknetEscrow.populate(
            'withdraw',
            CallData.compile({
                escrow_id: orderHashFelt,
                secret_part1: secretPart1Hex,
                secret_part2: secretPart2Hex
            })
        )

        const aliceInitialEthBalance = await ethContract.balanceOf(aliceStarknetAccount.address)
        console.log('aliceInitialEthBalance: ', aliceInitialEthBalance)

        const withdrawStarknetTx = await aliceStarknetAccount.execute(withdrawStarknetCall)
        await starknetProvider.waitForTransaction(withdrawStarknetTx.transaction_hash)
        console.log(
            `✅ Alice revealed secret and received ${order.takingAmount / 10n ** 18n} ETH | Tx: ${withdrawStarknetTx.transaction_hash}`
        )

        // Step 9: Bob extracts the secret from Starknet event and gets maker amount on source chain
        console.log('\n💰 STEP 9: Bob extracts secret from Starknet event and receives maker amount on EVM...')
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
        const withdrawResult = await bobEvmWallet.send(withdrawEvmTx)
        console.log(
            `✅ Bob extracted secret and received ${aliceInitialUsdcAmount / 10n ** 6n} USDC on EVM | Tx: ${withdrawResult.txHash}`
        )

        // Step 10: Verification
        console.log('\n✅ STEP 10: Verifying successful cross-chain swap...')
        const aliceFinalUsdc = await aliceEvmWallet.tokenBalance(usdcAddress)
        expect(aliceFinalUsdc).toBe(0n)
        // expect(true).toBe(true)
        console.log(`✅ Alice's final USDC balance: ${aliceFinalUsdc} (expected: 0)`)

        // Verify Alice received STRK on Starknet
        const aliceEthBalance = await ethContract.balanceOf(aliceStarknetAccount.address)
        const expectedEthAmount = order.takingAmount
        console.log(
            `✅ Alice's STRK balance on Starknet: ${(BigInt(aliceEthBalance) - aliceInitialEthBalance) / 10n ** 18n} STRK (expected: ${expectedEthAmount / 10n ** 18n})`
        )
        expect(BigInt(aliceEthBalance) - aliceInitialEthBalance).toBe(expectedEthAmount)

        console.log('\n🎉 CROSS-CHAIN SWAP COMPLETED SUCCESSFULLY!')
        console.log('='.repeat(60))
        console.log('📊 SWAP SUMMARY:')
        console.log(`   Alice (maker) sent: ${aliceInitialUsdcAmount / 10n ** 6n} USDC on Ethereum`)
        console.log(`   Alice received: ${order.takingAmount / 10n ** 18n} STRK on Starknet`)
        console.log(`   Bob (resolver) earned: ${aliceInitialUsdcAmount / 10n ** 6n} USDC by taking Alice's order`)
        console.log(`   Alice paid: ${aliceInitialUsdcAmount / 10n ** 6n} USDC and received: 1 ETH in return`)
        console.log(`   Secret was successfully revealed and utilized across chains`)
        console.log('='.repeat(60))

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

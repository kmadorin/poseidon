// tests_evm_starknet/helpers/starknet-helpers.ts
import {Account, Contract, Provider, RpcProvider, json} from 'starknet'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import {execSync} from 'child_process'

// Get current directory path
const currentDir = path.dirname(new URL(import.meta.url || 'file://' + __filename).pathname)

dotenv.config({path: path.resolve(currentDir, '../.env')})

export function getStarknetProvider(): RpcProvider {
    return new RpcProvider({nodeUrl: process.env.STARKNET_RPC_URL!})
}

export function getMakerAccount(provider: Provider): Account {
    return new Account(provider, process.env.MAKER_STARKNET_ADDRESS!, process.env.MAKER_STARKNET_PRIVATE_KEY!)
}

export function getResolverAccount(provider: Provider): Account {
    return new Account(provider, process.env.RESOLVER_STARKNET_ADDRESS!, process.env.RESOLVER_STARKNET_PRIVATE_KEY!)
}

export function getEscrowContract(provider: Provider, contractAddress: string): Contract {
    const compiledContract = JSON.parse(
        fs
            .readFileSync(
                path.resolve(
                    currentDir,
                    '../../contracts_starknet/target/dev/contracts_starknet_StarknetEscrow.contract_class.json'
                )
            )
            .toString()
    )

    return new Contract(compiledContract.abi, contractAddress, provider)
}

export async function getStarknetAccountBalance(address: string, unit: 'WEI' | 'FRI' = 'WEI'): Promise<string> {
    try {
        const rpcPayload = {
            jsonrpc: '2.0',
            id: '1',
            method: 'devnet_getAccountBalance',
            params: {
                address: address,
                unit: unit
            }
        }

        const response = await fetch(process.env.STARKNET_RPC_URL!, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(rpcPayload)
        })

        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`)
        }

        const result = await response.json()

        if (result.error) {
            throw new Error(`RPC error: ${JSON.stringify(result.error)}`)
        }

        return result.result?.balance || '0'
    } catch (error) {
        console.log('Error checking balance:', error)
        return '0'
    }
}

export async function fundStarknetAccount(address: string, amount: bigint, unit: 'WEI' | 'FRI' = 'WEI'): Promise<void> {
    const maxRetries = 3
    let retries = 0

    while (retries < maxRetries) {
        try {
            // Use proper JSON-RPC devnet_mint method according to StarkNet devnet docs
            const rpcPayload = {
                jsonrpc: '2.0',
                id: '1',
                method: 'devnet_mint',
                params: {
                    address: address,
                    amount: Number(amount),
                    unit: unit
                }
            }

            const response = await fetch(process.env.STARKNET_RPC_URL!, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(rpcPayload)
            })

            if (!response.ok) {
                const errorText = await response.text()
                console.log(`Failed to fund StarkNet account (attempt ${retries + 1}): ${errorText}`)

                if (retries === maxRetries - 1) {
                    throw new Error(`Failed to fund StarkNet account after ${maxRetries} attempts: ${errorText}`)
                }

                retries++
                await new Promise((resolve) => setTimeout(resolve, 2000 * retries)) // Exponential backoff
                continue
            }

            const result = await response.json()

            if (result.error) {
                console.log(`RPC error funding account (attempt ${retries + 1}):`, result.error)

                if (retries === maxRetries - 1) {
                    throw new Error(`RPC error: ${JSON.stringify(result.error)}`)
                }

                retries++
                await new Promise((resolve) => setTimeout(resolve, 2000 * retries))
                continue
            }

            console.log(
                `Funded ${address} with ${result.result?.new_balance || amount} ${unit} on StarkNet. TX: ${result.result?.tx_hash || 'N/A'}`
            )
            return
        } catch (error) {
            console.log(`Network error funding account (attempt ${retries + 1}):`, error)

            if (retries === maxRetries - 1) {
                throw error
            }

            retries++
            await new Promise((resolve) => setTimeout(resolve, 2000 * retries))
        }
    }
}

export async function compileAndDeployStarknetContract(): Promise<string> {
    const deploymentPath = path.resolve(currentDir, '../starknet-deployment.json')

    console.log('Compiling StarkNet contracts...')
    execSync('scarb build', {cwd: './contracts_starknet', stdio: 'inherit'})

    const provider = getStarknetProvider()

    // Log balances of the accounts using devnet API
    // Add small delay to ensure balance is updated after funding
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const makerBalance = await getStarknetAccountBalance(process.env.MAKER_STARKNET_ADDRESS!, 'WEI')
    const resolverBalance = await getStarknetAccountBalance(process.env.RESOLVER_STARKNET_ADDRESS!, 'WEI')
    console.log(`Maker Account balance: ${makerBalance} WEI`)
    console.log(`Resolver Account balance: ${resolverBalance} WEI`)

    // Ensure your .env file has the deployer's address and private key
    const deployerAccount = new Account(
        provider,
        process.env.MAKER_STARKNET_ADDRESS!,
        process.env.MAKER_STARKNET_PRIVATE_KEY!
    )

    console.log('Deploying StarkNet escrow contract...')

    const compiledContractPath = path.resolve(
        currentDir,
        '../../contracts_starknet/target/dev/contracts_starknet_StarknetEscrow.contract_class.json'
    )
    const compiledCasmPath = path.resolve(
        currentDir,
        '../../contracts_starknet/target/dev/contracts_starknet_StarknetEscrow.compiled_contract_class.json'
    )

    if (!fs.existsSync(compiledContractPath) || !fs.existsSync(compiledCasmPath)) {
        throw new Error('Contract not compiled. Please run "scarb build" in the "contracts_starknet" directory.')
    }

    const compiledContract = json.parse(fs.readFileSync(compiledContractPath).toString('ascii'))
    const compiledCasm = json.parse(fs.readFileSync(compiledCasmPath).toString('ascii'))

    console.log('Attempting to declare contract (using declareIfNot)...')
    console.log(`Deployer account address: ${deployerAccount.address}`)

    // Use declareIfNot to handle already declared contracts gracefully
    const declareResponse = await deployerAccount.declareIfNot({
        contract: compiledContract,
        casm: compiledCasm
    })

    if (declareResponse.transaction_hash) {
        console.log('Waiting for declaration transaction...')
        await provider.waitForTransaction(declareResponse.transaction_hash)
        console.log(`✅ Contract declared. Class hash: ${declareResponse.class_hash}`)
    } else {
        console.log(`✅ Contract already declared. Class hash: ${declareResponse.class_hash}`)
    }

    const {transaction_hash, contract_address} = await deployerAccount.deployContract({
        classHash: declareResponse.class_hash
    })

    console.log('Waiting for deployment transaction...')
    await provider.waitForTransaction(transaction_hash)
    console.log(`✅ Contract deployed to address: ${contract_address}`)

    return contract_address
}

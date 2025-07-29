// tests_evm_starknet/scripts/deploy-starknet.ts
import {Account, json, RpcProvider} from 'starknet'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

// Get current directory path
const currentDir = path.dirname(new URL(import.meta.url || 'file://' + __filename).pathname)

// Load environment variables from the correct path
dotenv.config({path: path.resolve(currentDir, '../.env')})

async function main() {
    const deploymentPath = path.resolve(currentDir, '../starknet-deployment.json')

    const provider = new RpcProvider({nodeUrl: process.env.STARKNET_RPC_URL!})

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

    const declareResponse = await deployerAccount.declare({
        contract: compiledContract,
        casm: compiledCasm
    })

    console.log('Waiting for declaration transaction...')
    await provider.waitForTransaction(declareResponse.transaction_hash)
    console.log(`✅ Contract declared. Class hash: ${declareResponse.class_hash}`)

    const {transaction_hash, contract_address} = await deployerAccount.deployContract({
        classHash: declareResponse.class_hash
    })

    console.log('Waiting for deployment transaction...')
    await provider.waitForTransaction(transaction_hash)
    console.log(`✅ Contract deployed to address: ${contract_address}`)

    const deploymentInfo = {
        classHash: declareResponse.class_hash,
        address: contract_address
    }

    fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2))
    console.log('✅ Deployment info saved to starknet-deployment.json')
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})

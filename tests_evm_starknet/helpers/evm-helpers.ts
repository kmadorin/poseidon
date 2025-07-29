// tests_evm_starknet/helpers/evm-helpers.ts
import { JsonRpcProvider, ContractFactory, Wallet as SignerWallet } from 'ethers';
import factoryContract from '../../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json';
import resolverContract from '../../dist/contracts/Resolver.sol/Resolver.json';
import { Wallet } from '../../tests/wallet';

export async function deployEvmContracts(provider: JsonRpcProvider, deployerPk: string, resolverPk: string) {
    const deployer = new SignerWallet(deployerPk, provider);
    const resolverWallet = new SignerWallet(resolverPk, provider);

    // Deploy TestEscrowFactory with required constructor parameters
    const limitOrderProtocol = '0x111111125421ca6dc452d289314280a0f8842a65'; // 1inch LOP address
    const feeToken = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'; // WETH address (wrapped native)
    const accessToken = '0x0000000000000000000000000000000000000000'; // Zero address for no access token
    const rescueDelaySrc = 1800; // 30 minutes (like original test)
    const rescueDelayDst = 1800; // 30 minutes (like original test)
    
    const escrowFactoryAddress = await deploy(
        factoryContract, 
        [limitOrderProtocol, feeToken, accessToken, deployer.address, rescueDelaySrc, rescueDelayDst], 
        provider, 
        deployer
    );
    console.log(`EscrowFactory contract deployed to: ${escrowFactoryAddress}`);

    const resolverAddress = await deploy(
        resolverContract,
        [escrowFactoryAddress, limitOrderProtocol, resolverWallet.address], // Use resolver as owner
        provider,
        deployer
    );
    console.log(`Resolver contract deployed to: ${resolverAddress}`);

    return { escrowFactoryAddress, resolverAddress };
}

async function deploy(
    json: { abi: any; bytecode: any },
    params: unknown[],
    provider: JsonRpcProvider,
    deployer: SignerWallet
): Promise<string> {
    const factory = new ContractFactory(json.abi, json.bytecode, deployer);
    const contract = await factory.deploy(...params);
    await contract.waitForDeployment();
    return contract.getAddress();
}

export async function topUpFromDonor(tokenAddress: string, recipient: string, amount: bigint, provider: JsonRpcProvider) {
    // Use one of Anvil's pre-funded accounts to fund the donor first
    const anvilAccount = new SignerWallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
    const donorAddress = "0xd54F23BE482D9A58676590fCa79c8E43087f92fB"; // USDC donor from config
    
    // First, fund the donor with ETH for gas
    await anvilAccount.sendTransaction({
        to: donorAddress,
        value: 10n ** 18n // 1 ETH for gas
    });
    
    const donorWallet = await Wallet.fromAddress(donorAddress, provider);
    await donorWallet.transferToken(tokenAddress, recipient, amount);
    console.log(`Topped up ${recipient} with ${amount} of token ${tokenAddress}`);
}

import { JsonRpcProvider } from 'ethers';
import { Wallet } from '../tests/wallet';
import { Resolver } from '../tests/resolver';
import Sdk from '@1inch/cross-chain-sdk';

// Add this debug test to inspect the transaction before sending
describe('Debug Transaction', () => {
    it('should inspect transaction data', async () => {
        const evmProvider = new JsonRpcProvider(process.env.EVM_RPC_URL!);
        const resolverEvmWallet = new Wallet(process.env.RESOLVER_PRIVATE_KEY!, evmProvider);
        
        // Create a minimal order for testing
        const order = Sdk.CrossChainOrder.new(
            new Sdk.Address('0x0000000000000000000000000000000000000001'), // dummy escrow factory
            {
                salt: 1n,
                maker: new Sdk.Address('0x0000000000000000000000000000000000000002'),
                makingAmount: 1000n,
                takingAmount: 1000n,
                makerAsset: new Sdk.Address('0x0000000000000000000000000000000000000003'),
                takerAsset: new Sdk.Address('0x0000000000000000000000000000000000000004')
            },
            {
                hashLock: Sdk.HashLock.forSingleFill('0x' + '0'.repeat(64)),
                timeLocks: Sdk.TimeLocks.new({
                    srcWithdrawal: 10n,
                    srcPublicWithdrawal: 120n,
                    srcCancellation: 121n,
                    srcPublicCancellation: 122n,
                    dstWithdrawal: 10n,
                    dstPublicWithdrawal: 100n,
                    dstCancellation: 101n
                }),
                srcChainId: 1,
                dstChainId: 56,
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
                whitelist: [],
                resolvingStartTime: 0n
            },
            {
                nonce: 1n,
                allowPartialFills: false,
                allowMultipleFills: false
            }
        );

        const resolver = new Resolver(
            '0xbdB493827007eE26c16F10F6EABad6E97D9ead7D', 
            '0xbdB493827007eE26c16F10F6EABad6E97D9ead7D'
        );
        
        const tx = resolver.deploySrc(
            1,
            order,
            '0x' + '0'.repeat(130), // dummy signature
            Sdk.TakerTraits.default()
                .setExtension(order.extension)
                .setAmountMode(Sdk.AmountMode.maker)
                .setAmountThreshold(order.takingAmount),
            order.makingAmount
        );

        console.log('Transaction details:');
        console.log('To:', tx.to);
        console.log('Data:', tx.data);
        console.log('Data length:', tx.data?.length);
        console.log('Value:', tx.value?.toString());
        
        // Decode the function call if data exists
        if (tx.data && tx.data.length > 10) {
            console.log('Function selector:', tx.data.substring(0, 10));
        }
    });
});

// Simple test to verify basic setup
import { describe, it, expect } from '@jest/globals';
import { JsonRpcProvider } from 'ethers';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, './.env') });

describe('Simple EVM-StarkNet Setup Test', () => {
    it('should have proper environment variables', () => {
        expect(process.env.EVM_RPC_URL).toBeDefined();
        expect(process.env.STARKNET_RPC_URL).toBeDefined();
        expect(process.env.MAKER_PRIVATE_KEY).toBeDefined();
        expect(process.env.RESOLVER_PRIVATE_KEY).toBeDefined();
        expect(process.env.MAKER_STARKNET_ADDRESS).toBeDefined();
        expect(process.env.MAKER_STARKNET_PRIVATE_KEY).toBeDefined();
        expect(process.env.RESOLVER_STARKNET_ADDRESS).toBeDefined();
        expect(process.env.RESOLVER_STARKNET_PRIVATE_KEY).toBeDefined();
        
        console.log('✅ All environment variables are configured');
    });

    it('should create EVM provider', () => {
        const provider = new JsonRpcProvider(process.env.EVM_RPC_URL!);
        expect(provider).toBeDefined();
        console.log('✅ EVM provider created successfully');
    });
});

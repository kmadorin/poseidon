/*
 * Jest configuration for EVM-StarkNet tests
 */

export default {
    clearMocks: true,
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: '.',
    testEnvironment: 'node',
    testMatch: ['**/tests_evm_starknet/**/?(*.)+(spec|test).[tj]s?(x)'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    transform: {
        '^.+\\.(t|j)s$': ['@swc/jest']
    },
    extensionsToTreatAsEsm: ['.ts', '.tsx'],
    transformIgnorePatterns: [
        // "/node_modules/",
        // "\\.pnp\\.[^\\/]+$",
    ],
    // Add these for better cleanup
    forceExit: true,
    detectOpenHandles: true,
    maxWorkers: 1
}

use core::keccak::keccak_u256s_be_inputs;
use core::integer;

/// Computes EVM-compatible keccak256 hash of a felt252 value
/// This function uses the same pattern as the working keccak.cairo implementation
pub fn keccak_felt252_to_felt252(input: felt252) -> felt252 {
    // Convert felt252 input to u256 for processing
    let input_u256: u256 = input.into();
    
    // Create a span with the single u256 value for hashing
    let input_data = array![input_u256].span();
    
    // Compute keccak hash using big-endian inputs (exact same as keccak.cairo)
    let hashed = keccak_u256s_be_inputs(input_data);
    
    // Apply byte reversal to match EVM's format (exact same pattern as keccak.cairo)
    let low: u128 = hashed.low;
    let high: u128 = hashed.high;
    
    let reversed_low = integer::u128_byte_reverse(low);
    let reversed_high = integer::u128_byte_reverse(high);
    
    // Reconstruct the EVM-compatible hash (exact same as keccak.cairo)
    let compatible_hash = u256 { low: reversed_high, high: reversed_low };
    
    // Convert the result back to felt252 for use in the escrow contract
    // Use simple conversion - if it doesn't fit, we'll get a panic which is appropriate
    compatible_hash.try_into().expect('Hash conversion failed')
}
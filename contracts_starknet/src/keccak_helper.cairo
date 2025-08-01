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
    // Use modular arithmetic to ensure the result fits in felt252
    // This is safe because we're working with hash values where the exact value matters
    // and modular reduction preserves the hash properties for comparison
    let felt_max: u256 = 0x800000000000011000000000000000000000000000000000000000000000001_u256;
    let reduced_hash = compatible_hash % felt_max;
    
    // Now the conversion should always succeed since we've reduced it to fit in felt252
    reduced_hash.try_into().unwrap()
}

/// Reconstructs a u256 from two felt252 parts and computes its EVM-compatible keccak256 hash.
///
/// # Arguments
/// * `part1` - The most significant 128 bits (16 bytes) of the secret.
/// * `part2` - The least significant 128 bits (16 bytes) of the secret.
///
/// # Returns
/// A felt252 representing the keccak256 hash of the reconstructed secret.
pub fn keccak_2_felts_to_felt252(part1: felt252, part2: felt252) -> felt252 {
    // Step 1: Define the SHIFT amount to move the high part to the correct position.
    // This is 2**128.
    let SHIFT: u256 = 0x100000000000000000000000000000000_u256;

    // Step 2: Convert both felt252 parts into u256 values.
    let high_part_u256: u256 = part1.into();
    let low_part_u256: u256 = part2.into();

    // Step 3: Shift the high part left by 128 bits and add the low part
    // to reconstruct the original 32-byte secret.
    let full_secret_u256 = high_part_u256 * SHIFT + low_part_u256;

    // Step 4: Now, use the existing hashing logic on the fully reconstructed u256.
    let input_data = array![full_secret_u256].span();
    let hashed = keccak_u256s_be_inputs(input_data);

    // Step 5: Apply the byte reversal to match EVM's format.
    let reversed_low = integer::u128_byte_reverse(hashed.low);
    let reversed_high = integer::u128_byte_reverse(hashed.high);
    let compatible_hash = u256 { low: reversed_high, high: reversed_low };
    
    // Step 6: Convert the final hash back to felt252.
    // The modulo is necessary because a keccak hash (256 bits) can be larger than a felt252.
    let felt_max: u256 = 0x800000000000011000000000000000000000000000000000000000000000001_u256;
    let reduced_hash = compatible_hash % felt_max;
    reduced_hash.try_into().unwrap()
}

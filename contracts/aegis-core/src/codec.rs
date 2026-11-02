//! Small, dependency-free encoding helpers shared by every module.
//!
//! Everything here is mirrored byte-for-byte in `packages/agent-swarm-sdk/src/encoding.ts`
//! and covered by parity tests on both sides.

use near_sdk::{CurveType, PublicKey};

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Lower-case hex encoding.
pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Decodes hex with an optional `0x` prefix.
pub fn from_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        out.push((hex_val(pair[0])? << 4) | hex_val(pair[1])?);
    }
    Some(out)
}

/// Parses a 32-byte digest written as 64 hex characters.
pub fn parse_hash32(s: &str) -> Option<[u8; 32]> {
    let v = from_hex(s)?;
    v.try_into().ok()
}

pub fn is_hash32_hex(s: &str) -> bool {
    s.len() == 64 && parse_hash32(s).is_some()
}

/// A TEE code measurement in hex: 32 bytes (a synthetic sha256) or 48 bytes (a real Intel TDX
/// MRTD / RTMR, which is SHA-384). Both are accepted so real NEAR AI Cloud `mr_td` values and
/// deterministic offline measurements validate the same way.
pub fn is_measurement_hex(s: &str) -> bool {
    (s.len() == 64 || s.len() == 96) && from_hex(s).is_some()
}

/// Decodes a NEAR-style signature string `ed25519:<base58>` into 64 raw bytes.
pub fn decode_ed25519_signature(s: &str) -> Option<[u8; 64]> {
    let body = s.strip_prefix("ed25519:")?;
    let raw = near_sdk::bs58::decode(body).into_vec().ok()?;
    raw.try_into().ok()
}

/// Raw 32-byte ed25519 key from a NEAR `PublicKey` (which carries a curve-type prefix byte).
pub fn ed25519_key_bytes(pk: &PublicKey) -> Option<[u8; 32]> {
    if pk.curve_type() != CurveType::ED25519 {
        return None;
    }
    let bytes = pk.as_bytes();
    bytes.get(1..33)?.try_into().ok()
}

/// Decodes a standard (padded) base64 string into exactly 32 bytes.
pub fn decode_nonce_b64(s: &str) -> Option<[u8; 32]> {
    use near_sdk::base64::engine::general_purpose::STANDARD;
    use near_sdk::base64::Engine;
    let raw = STANDARD.decode(s).ok()?;
    raw.try_into().ok()
}

/// Formats nanoseconds since the Unix epoch as `YYYY-MM-DDTHH:MM:SS.mmmZ`,
/// the exact output of JavaScript's `Date.prototype.toISOString()`.
pub fn format_iso8601_millis(ns: u64) -> String {
    let millis = ns / 1_000_000;
    let secs = millis / 1000;
    let ms = millis % 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{ms:03}Z")
}

/// Howard Hinnant's days-to-civil algorithm (proleptic Gregorian calendar).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// NEAR Intents asset identifiers, e.g. `nep141:wrap.near` or
/// `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near`.
pub fn is_valid_asset_id(s: &str) -> bool {
    let Some((standard, rest)) = s.split_once(':') else {
        return false;
    };
    matches!(standard, "nep141" | "nep245" | "nep171")
        && !rest.is_empty()
        && s.len() <= 160
        && rest.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-' | b'_' | b':'))
}

/// Chain identifiers follow the 1Click `blockchain` enum (lower-case ASCII).
pub fn is_valid_chain_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 16 && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Printable ASCII without quotes/backslashes keeps canonical JSON identical across Rust and JS.
pub fn is_safe_ascii(s: &str, max_len: usize) -> bool {
    s.len() <= max_len && s.bytes().all(|c| (0x20..0x7f).contains(&c) && c != b'"' && c != b'\\')
}

/// `0x` followed by 40 hex characters.
pub fn is_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && from_hex(s).is_some()
}

/// Lower-case `0x` address, as stored in allow-lists and EVM policies.
pub fn is_lower_evm_address(s: &str) -> bool {
    is_evm_address(s) && !s.bytes().any(|c| c.is_ascii_uppercase())
}

/// Allow-list key of a destination: `<chain>:<address>`. EVM addresses are case-insensitive, so
/// they are lower-cased; NEAR account ids are already canonical.
pub fn recipient_key(chain: &str, recipient: &str) -> String {
    if recipient.starts_with("0x") {
        format!("{chain}:{}", recipient.to_ascii_lowercase())
    } else {
        format!("{chain}:{recipient}")
    }
}

/// A well-formed allow-list entry: valid chain id, `:`, then a lower-case EVM address or a
/// non-empty safe identifier (NEAR account id, Solana address, ...).
pub fn is_valid_recipient_entry(entry: &str) -> bool {
    let Some((chain, address)) = entry.split_once(':') else {
        return false;
    };
    is_valid_chain_id(chain)
        && !address.is_empty()
        && is_safe_ascii(address, 128)
        && !address.contains(' ')
        && (!address.starts_with("0x") || is_lower_evm_address(address))
}

/// Decodes an ed25519 signature written as `ed25519:<base58>` or as hex (optional `0x`).
pub fn decode_ed25519_signature_any(s: &str) -> Option<[u8; 64]> {
    if s.starts_with("ed25519:") {
        decode_ed25519_signature(s)
    } else {
        from_hex(s)?.try_into().ok()
    }
}

/// Nonce labels bound into proofs: 8..=64 characters of `[A-Za-z0-9_-]`.
pub fn is_nonce_label(s: &str) -> bool {
    (8..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

#[cfg(test)]
mod codec_tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        let data = [0u8, 1, 0xab, 0xff];
        assert_eq!(to_hex(&data), "0001abff");
        assert_eq!(from_hex("0x0001ABff").unwrap(), data.to_vec());
        assert!(from_hex("abc").is_none());
        assert!(from_hex("zz").is_none());
    }

    #[test]
    fn iso8601_matches_javascript_to_iso_string() {
        // new Date(Date.UTC(2026, 10, 1)).toISOString() === "2026-11-01T00:00:00.000Z"
        assert_eq!(format_iso8601_millis(1_793_491_200_000_000_000), "2026-11-01T00:00:00.000Z");
        // new Date(951782400123).toISOString() === "2000-02-29T00:00:00.123Z"
        assert_eq!(format_iso8601_millis(951_782_400_123_000_000), "2000-02-29T00:00:00.123Z");
        assert_eq!(format_iso8601_millis(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn measurement_accepts_sha256_and_tdx_lengths_check() {
        assert!(is_measurement_hex(&"a".repeat(64)), "32-byte sha256");
        assert!(is_measurement_hex(&"7f".repeat(48)), "48-byte Intel TDX MRTD");
        assert!(!is_measurement_hex(&"a".repeat(40)), "20 bytes rejected");
        assert!(!is_measurement_hex(&("z".repeat(96))), "non-hex rejected");
    }

    #[test]
    fn asset_and_chain_validation() {
        assert!(is_valid_asset_id("nep141:wrap.near"));
        assert!(is_valid_asset_id("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"));
        assert!(!is_valid_asset_id("wrap.near"));
        assert!(!is_valid_asset_id("nep141:WRAP.near"));
        assert!(is_valid_chain_id("arb"));
        assert!(!is_valid_chain_id("Arb"));
        assert!(is_safe_ascii("Q4 vendor invoice #12", 64));
        assert!(!is_safe_ascii("bad\"quote", 64));
    }

    #[test]
    fn recipient_entries_are_canonical() {
        assert_eq!(recipient_key("arb", "0xAbC0000000000000000000000000000000000001"), "arb:0xabc0000000000000000000000000000000000001");
        assert_eq!(recipient_key("near", "vendor-a.testnet"), "near:vendor-a.testnet");
        assert!(is_valid_recipient_entry("arb:0xabc0000000000000000000000000000000000001"));
        assert!(!is_valid_recipient_entry("arb:0xABC0000000000000000000000000000000000001"), "EVM entries must be lower-case");
        assert!(is_valid_recipient_entry("near:vendor-a.testnet"));
        assert!(!is_valid_recipient_entry("vendor-a.testnet"), "chain prefix required");
        assert!(is_nonce_label("exec-3-cipher"));
        assert!(!is_nonce_label("short"));
        assert_eq!(decode_ed25519_signature_any(&format!("0x{}", "11".repeat(64))), Some([0x11; 64]));
    }
}

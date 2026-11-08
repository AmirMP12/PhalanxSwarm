import { describe, expect, it } from "vitest";

import {
  BorshWriter,
  canonicalJson,
  formatNear,
  isoMillis,
  keyPairFromSeed,
  keyPairFromSecretString,
  parseNear,
  publicKeyFromBorsh,
  publicKeyToBorsh,
  readU128LE,
  signEd25519,
  toHex,
  utf8,
  verifyEd25519,
} from "../src/index.ts";

describe("encoding primitives (mirrors contracts/phalanx-core/src/codec.rs)", () => {
  it("formats nanosecond timestamps exactly like format_iso8601_millis", () => {
    expect(isoMillis(1_793_491_200_000_000_000n)).toBe("2026-11-01T00:00:00.000Z");
    expect(isoMillis(951_782_400_123_000_000n)).toBe("2000-02-29T00:00:00.123Z");
    expect(isoMillis(0n)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("produces sorted-key JSON without whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: "x" } })).toBe('{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}');
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/);
  });

  it("writes little-endian borsh integers and length-prefixed strings", () => {
    const bytes = new BorshWriter()
      .u32(2_147_484_061)
      .u64(1n)
      .u128(2n ** 64n + 5n)
      .string("ab")
      .toBytes();
    expect(toHex(bytes)).toBe("9d0100800100000000000000" + "0500000000000000" + "0100000000000000" + "02000000" + "6162");
    expect(readU128LE(bytes.slice(12, 28))).toBe(2n ** 64n + 5n);
  });

  it("converts NEAR amounts exactly", () => {
    expect(parseNear("1.5")).toBe(1_500_000_000_000_000_000_000_000n);
    expect(parseNear(12)).toBe(12n * 10n ** 24n);
    expect(formatNear(6_200_000_000_000_000_000_000_000n, 2)).toBe("6.20");
    expect(formatNear("-10000000000000000000000", 3)).toBe("-0.010");
    expect(() => parseNear("1e3")).toThrow();
  });

  it("derives deterministic ed25519 keys and verifies signatures", () => {
    const a = keyPairFromSeed("agent-a");
    expect(keyPairFromSeed("agent-a").publicKeyString).toBe(a.publicKeyString);
    expect(keyPairFromSecretString(a.secretKeyString).publicKeyString).toBe(a.publicKeyString);
    const sig = signEd25519(a, utf8("hello"));
    expect(verifyEd25519(sig, utf8("hello"), a.publicKeyString)).toBe(true);
    expect(verifyEd25519(sig, utf8("hellO"), a.publicKeyString)).toBe(false);
    expect(verifyEd25519(sig, utf8("hello"), keyPairFromSeed("agent-b").publicKeyString)).toBe(false);
    expect(publicKeyFromBorsh(publicKeyToBorsh(a.publicKeyString))).toBe(a.publicKeyString);
  });
});

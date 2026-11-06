"use client";

import { useEffect, useState } from "react";

/**
 * Public evidence copied from artifacts/ to /evidence/ at build time (scripts/copy-wasm.mjs).
 * The files hold account ids, transaction hashes, measurements and verdicts, never keys.
 * Each file is fetched at most once per page load.
 */

let index: Promise<string[]> | null = null;
const files = new Map<string, Promise<unknown>>();

/** `/evidence/index.json` lists the files that exist, so the UI never requests a missing one. */
export function availableEvidence(): Promise<string[]> {
  index ??= fetch("/evidence/index.json", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<{ files?: unknown }>) : null))
    .then((body) => (Array.isArray(body?.files) ? body.files.filter((f): f is string => typeof f === "string") : []))
    .catch(() => []);
  return index;
}

export function loadEvidence<T>(name: string): Promise<T | null> {
  let p = files.get(name);
  if (!p) {
    p = availableEvidence().then(async (available) => {
      if (!available.includes(name)) return null;
      try {
        const res = await fetch(`/evidence/${name}`, { cache: "no-store" });
        return res.ok ? ((await res.json()) as unknown) : null;
      } catch {
        return null;
      }
    });
    files.set(name, p);
  }
  return p as Promise<T | null>;
}

/** artifacts/testnet-swarm.json, written by `pnpm testnet:swarm`. */
export interface SwarmEvidence {
  contract_id: string;
  contract_version: string;
  wasm_sha256: string;
  dao_id: string;
  owner_id: string;
  inference: "nearai" | "generic_llm" | "standin";
  model: string | null;
  timestamp: string;
  deployer_full_access_keys: number;
  transactions: Record<string, { hash: string; explorer: string }>;
  vendor_payment: { recipient: string; amount_near: string; status: string } | null;
  evm: { chain: string; chain_id: number; from: string; to: string; value_wei: string; tx_hash: string | null; explorer: string | null; status: string } | null;
  attack: { status: string; violations: string[]; quarantined: boolean; key_deleted?: boolean } | null;
  governance?: { proposal_id: number; action: string; agent_status: string } | null;
}

/** artifacts/reproducible-build.json, written by `pnpm verify:reproducible`. */
export interface ReproEvidence {
  image: string;
  wasm_sha256: string;
  size_bytes: number;
  two_clean_builds_byte_identical: boolean;
}

function useEvidence<T>(name: string): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadEvidence<T>(name).then((v) => {
      if (!cancelled) setValue(v);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);
  return value;
}

export const useSwarmEvidence = () => useEvidence<SwarmEvidence>("testnet-swarm.json");
export const useReproEvidence = () => useEvidence<ReproEvidence>("reproducible-build.json");

"use client";

import { useMemo } from "react";

import { useSwarmEvidence } from "./evidence";

/**
 * Explorer links of the recorded testnet run (`artifacts/testnet-swarm.json`, copied to
 * `/evidence/` at build time), keyed by step name, so each in-browser rehearsal result can link
 * the same step on the public network.
 */
export function useTestnetTxs(): Record<string, string> {
  const swarm = useSwarmEvidence();
  return useMemo(
    () => Object.fromEntries(Object.entries(swarm?.transactions ?? {}).flatMap(([name, tx]) => (tx?.explorer ? [[name, tx.explorer]] : []))),
    [swarm],
  );
}

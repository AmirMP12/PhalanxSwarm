"use client";

import type { CallResult, Signer, SwarmRuntime } from "@aegis/agent-swarm-sdk";
import { useCallback } from "react";

import { toast, type ToastInput } from "@/components/ui/toast";

import { useAegis } from "./aegis-context";

/**
 * `act` from the Aegis context plus a toast with the outcome. `describe` can override the toast,
 * e.g. when the transaction succeeds but the policy engine rejected the request.
 */
export function useAction() {
  const { act } = useAegis();
  return useCallback(
    async <T>(
      label: string,
      signer: Signer,
      method: string,
      fn: (rt: SwarmRuntime) => Promise<CallResult<T>>,
      /** Return a toast to show, `null` for none, or `undefined` for the default ok/rejected toast. */
      describe?: (r: CallResult<T>) => ToastInput | null | undefined,
    ): Promise<CallResult<T> | null> => {
      const r = await act(label, signer, method, fn);
      if (!r) return r;
      const custom = describe?.(r);
      if (custom !== undefined) {
        if (custom) toast(custom);
      } else if (r.ok) {
        toast({ tone: "success", title: label, description: `${method} · ok${r.events.length ? ` · ${r.events.map((e) => e.event).join(", ")}` : ""}` });
      } else {
        toast({ tone: "error", title: `Rejected: ${label}`, description: r.error ?? method });
      }
      return r;
    },
    [act],
  );
}

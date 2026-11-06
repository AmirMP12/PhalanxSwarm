"use client";

import { useEffect, useSyncExternalStore } from "react";

import { connectedAccount, getConnector } from "./wallet";

let account: string | null = null;
let started = false;
const listeners = new Set<() => void>();
const set = (a: string | null) => {
  account = a;
  listeners.forEach((l) => l());
};

function start() {
  if (started) return;
  started = true;
  void connectedAccount().then((s) => set(s?.accountId ?? null));
  void getConnector().then((c) => {
    c.on("wallet:signIn", ({ accounts }) => set(accounts[0]?.accountId ?? null));
    c.on("wallet:signOut", () => set(null));
  });
}

export async function connectWallet(): Promise<void> {
  const c = await getConnector();
  await c.connect();
}

export async function disconnectWallet(): Promise<void> {
  const c = await getConnector();
  await c.disconnect();
  set(null);
}

export function useWalletAccount(): string | null {
  useEffect(start, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => account,
    () => null,
  );
}

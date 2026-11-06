import { formatNear } from "@aegis/agent-swarm-sdk";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function nearFmt(yocto: string | bigint | null | undefined, digits = 2): string {
  if (yocto === null || yocto === undefined) return "—";
  return `${formatNear(typeof yocto === "bigint" ? yocto : BigInt(yocto), digits)} Ⓝ`;
}

/** yoctoNEAR → NEAR as a JS number (display only: charts and animated counters). */
export function toNear(yocto: string | bigint | null | undefined): number {
  if (yocto === null || yocto === undefined) return 0;
  return Number(formatNear(typeof yocto === "bigint" ? yocto : BigInt(yocto), 6));
}

const WEI_PER_ETH = 10n ** 18n;

/** wei → "0.001 ETH" (up to 6 decimals, trailing zeros trimmed). */
export function ethFmt(wei: string | bigint): string {
  const v = typeof wei === "bigint" ? wei : BigInt(wei);
  const frac = (v % WEI_PER_ETH).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return `${v / WEI_PER_ETH}${frac ? `.${frac}` : ""} ETH`;
}

export function short(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(-tail) : ""}`;
}

export function pct(value: bigint, max: bigint): number {
  if (max <= 0n) return 0;
  return Math.max(0, Math.min(100, Number((value * 10_000n) / max) / 100));
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

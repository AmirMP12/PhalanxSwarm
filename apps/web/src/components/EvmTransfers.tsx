"use client";

import {
  NATIVE_ASSET,
  type EvmChainPolicyT,
  type EvmTxRecordT,
  type EvmTxPreviewT,
  type EvmTransferRequestT,
  type SwarmRuntime,
} from "@phalanx/agent-swarm-sdk";
import { Ban, Check, Cpu, FileSignature, Gauge, ScanEye, Send, ShieldCheck, Signature, X } from "lucide-react";
import { useState } from "react";

import { usePhalanx } from "@/lib/phalanx-context";
import { useAction } from "@/lib/use-action";

import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  CodeBlock,
  CopyButton,
  EmptyState,
  Field,
  KV,
  PersonaAvatar,
  SkeletonBlock,
  cx,
  ethFmt,
  short,
  usePersonaOf,
  type Tone,
} from "./ui";

const WEI = 10n ** 18n;

/** "0.001" ETH → wei, without floating point. */
function parseEth(v: string): bigint {
  const trimmed = v.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") throw new Error("Enter an ETH amount, e.g. 0.001");
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 18) throw new Error("At most 18 decimals");
  return BigInt(whole || "0") * WEI + BigInt(frac.padEnd(18, "0") || "0");
}

const evmTone = (s: string): Tone =>
  s === "confirmed" ? "emerald" : s === "signed" ? "sky" : s === "rejected" || s === "authorization_failed" ? "red" : s === "cancelled" ? "amber" : "slate";

interface Draft {
  request: EvmTransferRequestT;
  preview: EvmTxPreviewT;
  receipt: Parameters<SwarmRuntime["submitEvmTransfer"]>[1]["attestation"];
  verdict: string;
  findings: string[];
}

/**
 * Chain Signatures, authored from the UI: the contract builds the EIP-1559 transaction, the
 * Sentinel's model audits it against facts the contract wrote, the MPC signs it, and anyone can
 * verify the recovered sender is the treasury's derived address. The contract owns the nonce, so a
 * signed-but-unmined transfer can be cancelled with a zero-value replacement at the same nonce.
 */
export function EvmTransferPanel() {
  const { runtime, dashboard, busy, refresh } = usePhalanx();
  const action = useAction();
  const [chainName, setChainName] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.001");
  const [memo, setMemo] = useState("vendor gas float");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const personaOf = usePersonaOf();
  const chains = dashboard?.policy.evm_chains ?? [];
  const chain: EvmChainPolicyT | undefined = chains.find((c) => c.chain === chainName) ?? chains[0];
  const records = dashboard?.evm_txs ?? [];
  const disabled = busy !== null || working !== null || !runtime || !chain;

  const amountError = (() => {
    try {
      const wei = parseEth(amount);
      if (wei <= 0n) return "Must be more than 0";
      if (chain && wei > BigInt(chain.max_value_wei)) return `Above the chain's ${ethFmt(chain.max_value_wei)} per-tx cap`;
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid amount";
    }
  })();
  const toError = !to ? null : !/^0x[0-9a-fA-F]{40}$/.test(to.trim()) ? "A 0x-prefixed 20-byte hex address" : undefined;
  const invalid = Boolean(amountError) || Boolean(toError);

  const run = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  const buildAndAudit = () =>
    run("building and auditing the transfer", async () => {
      if (!runtime || !chain) return;
      const nonce = await runtime.nextEvmNonce(chain.chain);
      const request = runtime.buildEvmTransfer({
        chain: chain.chain,
        to: to.trim(),
        asset: NATIVE_ASSET,
        amount: parseEth(amount),
        nonce,
        maxFeePerGas: BigInt(chain.max_fee_wei),
        memo: memo.trim() || undefined,
      });
      const preview = await runtime.previewEvmTransfer(request);
      const audit = await runtime.auditEvmTransfer("rhea", request);
      setDraft({ request, preview, receipt: audit.receipt, verdict: audit.verdict, findings: audit.findings });
    });

  const submit = () =>
    run("submitting to the policy engine", async () => {
      if (!runtime || !draft) return;
      const r = await action(
        `Rhea requests ${amount} ETH on ${draft.request.chain}`,
        runtime.agents.rhea.signer,
        "request_evm_transfer",
        (rt) => rt.submitEvmTransfer("rhea", { ...draft.request, attestation: draft.receipt }),
        (res) =>
          res.ok && res.value
            ? {
                tone: res.value.status === "rejected" ? "error" : "success",
                title: `EVM tx #${res.value.tx_id} → ${res.value.status}`,
                description: res.value.severity,
              }
            : undefined,
      );
      if (!r?.ok) throw new Error(r?.error ?? "the policy engine rejected the transfer");
      setDraft(null);
      await refresh();
    });

  const cancel = (record: EvmTxRecordT) =>
    void action(`Sentinel cancels EVM tx #${record.tx_id}`, runtime!.agents.sentinel.signer, "cancel_evm_transfer", (rt) =>
      rt.cancelEvmTransfer(record.tx_id, (BigInt(record.max_fee_per_gas) * 12n) / 10n, (BigInt(record.max_priority_fee_per_gas) * 12n) / 10n),
    );

  const confirm = (record: EvmTxRecordT) => {
    if (!record.tx_hash) return;
    void action(`Sentinel confirms EVM tx #${record.tx_id}`, runtime!.agents.sentinel.signer, "confirm_evm_transfer", (rt) =>
      rt.confirmEvmTransfer(record.tx_id, record.tx_hash!),
    );
  };

  if (!runtime || !dashboard)
    return (
      <Card className="p-4 sm:p-5">
        <CardHeader icon={Signature} eyebrow="Chain Signatures · EIP-1559 · MPC" title="EVM transfers" />
        <div className="mt-5">
          <SkeletonBlock rows={5} />
        </div>
      </Card>
    );

  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <CardHeader
        icon={Signature}
        eyebrow="request_evm_transfer · preview · cancel · confirm"
        title="EVM transfers (Chain Signatures)"
        description="The treasury's EVM address is a Chain Signatures derivative of this contract. The contract builds the EIP-1559 transaction, the Sentinel audits the facts the contract wrote, and the MPC signs. A signed transaction that is never mined is replaced by a zero-value cancel at the same nonce."
        actions={records.length > 0 ? <Badge tone="slate">{records.length} transfers</Badge> : undefined}
      />

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium text-slate-400">Chain (DAO policy)</span>
          <select
            value={chain?.chain ?? ""}
            disabled={disabled}
            onChange={(e) => setChainName(e.target.value)}
            className="touch-target h-9 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[13px] text-slate-200 outline-none focus:border-emerald-400/50"
          >
            {chains.map((c) => (
              <option key={c.chain} value={c.chain} className="bg-[#0b1220]">
                {c.chain} ({c.chain_id}) · ≤ {ethFmt(c.max_value_wei)}
              </option>
            ))}
          </select>
        </label>
        <Field label="To (allow-listed recipient)" placeholder="0x…" value={to} error={toError} onChange={(e) => setTo(e.target.value)} />
        <Field
          label="Amount"
          suffix="ETH"
          inputMode="decimal"
          value={amount}
          error={amountError}
          presets={["0.001", "0.005", "0.01"]}
          onPreset={setAmount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Field label="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </div>

      <div aria-live="polite" className="mt-3 space-y-2">
        {working && (
          <div className="flex items-center gap-2 text-[12.5px] text-sky-300">
            <span className="size-3 animate-spin rounded-full border-2 border-sky-300/30 border-t-sky-300" aria-hidden /> {working}…
          </div>
        )}
        {error && (
          <Callout tone="red" icon={Ban}>
            <span className="num">{error}</span>
          </Callout>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={FileSignature} disabled={disabled || invalid} onClick={() => void buildAndAudit()}>
          1 · Build + Sentinel audit
        </Button>
        <Button size="sm" icon={Send} disabled={disabled || !draft || draft.verdict !== "approve"} onClick={() => void submit()}>
          2 · Submit to policy engine
        </Button>
        {chain && (
          <Badge tone="slate" icon={Gauge}>
            epoch cap {ethFmt(chain.epoch_cap_wei)}
          </Badge>
        )}
      </div>

      {draft && (
        <div className="mt-3 space-y-2">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-1">
            <KV k="chain id" v={String(draft.preview.chain_id)} />
            <KV k="tx.to (contract-built)" v={<span title={draft.preview.tx_to}>{short(draft.preview.tx_to, 12, 6)}</span>} />
            <KV k="tx.value" v={ethFmt(draft.preview.tx_value)} />
            <KV k="signing hash" v={<span title={draft.preview.signing_hash}>{short(draft.preview.signing_hash, 16, 8)}</span>} />
          </div>
          <div
            className={cx(
              "rounded-xl border p-3 text-[12px]",
              draft.verdict === "approve" ? "border-emerald-400/25 bg-emerald-400/[0.05]" : "border-red-400/30 bg-red-500/[0.06]",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-slate-200">
                <ScanEye className="size-4 text-violet-300" aria-hidden /> Sentinel audit over the contract&apos;s facts
              </span>
              <Badge tone={draft.verdict === "approve" ? "emerald" : "red"} dot>
                {draft.verdict}
              </Badge>
            </div>
            {draft.findings.map((f) => (
              <div key={f} className="mt-1 text-red-300">
                • {f}
              </div>
            ))}
          </div>
          <CodeBlock title="unsigned EIP-1559 transaction" actions={<CopyButton text={draft.preview.unsigned_tx} label="Copy raw tx" iconOnly />}>
            <span className="num whitespace-pre-wrap break-all text-slate-300">{draft.preview.unsigned_tx}</span>
          </CodeBlock>
        </div>
      )}

      <div className="mt-4 flex-1">
        {records.length === 0 ? (
          <EmptyState icon={Cpu} title="No EVM transfers" hint="Author one above, or run the judge scenario." />
        ) : (
          <ul tabIndex={0} aria-label="EVM transfers" className="fade-bottom max-h-[320px] space-y-1.5 overflow-y-auto pb-3 pr-1">
            {records.map((t) => {
              const p = personaOf(t.agent_id);
              const chainPolicy = chains.find((c) => c.chain === t.chain);
              const check = chainPolicy ? runtime.verifyEvmTransfer(t, chainPolicy) : null;
              const cancellable = t.status === "signed";
              return (
                <li key={t.tx_id} className="rounded-lg border border-violet-400/15 bg-violet-400/[0.03] p-2.5 text-[12px]">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {p ? <PersonaAvatar persona={p} size={24} /> : <Cpu className="size-4 text-violet-300" aria-hidden />}
                    <span className="num text-slate-200">#{t.tx_id}</span>
                    <span className="num text-slate-400">{t.asset === NATIVE_ASSET ? ethFmt(t.amount) : `${t.amount} units`}</span>
                    <span className="num truncate text-slate-300" title={t.to}>
                      → {short(t.to, 8, 4)}
                    </span>
                    <Badge tone={evmTone(t.status)} dot className="ml-auto">
                      {t.kind === "cancel" ? `cancel · ${t.status}` : t.status}
                    </Badge>
                  </div>
                  <div className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-slate-500">
                    <span>
                      {t.chain} ({t.chain_id}) · nonce {t.nonce}
                    </span>
                    {t.invoice_ref && <span>invoice {t.invoice_ref}</span>}
                    {check && (
                      <span className={check.valid ? "text-emerald-300/90" : "text-red-300"} title={`${check.sender} = ${check.expected}`}>
                        sender {short(check.sender, 8, 4)} {check.valid ? "= treasury ✔" : "≠ treasury ✘"}
                      </span>
                    )}
                    {t.tx_hash && (
                      <span title={t.tx_hash} className="flex items-center gap-1">
                        <ShieldCheck className="size-3" aria-hidden /> {short(t.tx_hash, 10, 6)}
                      </span>
                    )}
                  </div>
                  {t.violations.length > 0 && <div className="num mt-1 text-[10.5px] text-red-300">{t.violations.map((v) => v.code).join(" · ")}</div>}
                  {t.error && <div className="mt-1 text-[10.5px] text-red-300">{t.error}</div>}
                  {(cancellable || t.tx_hash) && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {cancellable && (
                        <Button size="sm" variant="ghost" icon={X} disabled={disabled} onClick={() => cancel(t)}>
                          Cancel (zero-value replacement)
                        </Button>
                      )}
                      {t.tx_hash && t.status === "signed" && (
                        <Button size="sm" icon={Check} disabled={disabled} onClick={() => confirm(t)}>
                          Confirm mined
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

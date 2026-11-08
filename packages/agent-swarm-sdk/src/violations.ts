/** One plain-English sentence per policy-engine violation code (web UI, MCP server, CLIs). */
import { formatNear } from "./encoding.ts";
import type { PolicyViolationT } from "./types.ts";

const n = (yocto: string) => `${formatNear(BigInt(yocto), 2)} NEAR`;

function short(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(-tail) : ""}`;
}

function who(recipient: string): string {
  return recipient.startsWith("0x") ? short(recipient, 10, 6) : short(recipient, 32, 0);
}

export function describeViolation(v: PolicyViolationT): string {
  switch (v.code) {
    case "protocol_paused":
      return "The protocol is paused.";
    case "agent_not_active":
      return `The agent is ${v.status}.`;
    case "amount_exceeds_tx_limit":
      return `${n(v.amount)} is above the per-payment limit of ${n(v.limit)}.`;
    case "agent_epoch_cap_exceeded":
      return `The agent's spending cap for this epoch (${n(v.cap)}) would be exceeded.`;
    case "global_epoch_cap_exceeded":
      return `The treasury's spending cap for this epoch (${n(v.cap)}) would be exceeded.`;
    case "chain_not_allowed":
      return `Chain ${v.chain} is not allowed.`;
    case "contract_not_allowed":
      return `Contract ${v.contract_id} is not allowed.`;
    case "asset_not_allowed":
      return `Asset ${short(v.asset, 18, 6)} is not allowed.`;
    case "slippage_too_high":
      return `Slippage ${v.slippage_bps} bps is above the ${v.max_bps} bps limit.`;
    case "velocity_exceeded":
      return `${v.requests} requests in ${v.window_sec} s is above the limit of ${v.limit}.`;
    case "missing_tee_attestation":
      return "No signed audit (TEE proof) is attached.";
    case "invalid_tee_attestation":
      return `The attached proof does not verify: ${v.reason}.`;
    case "invalid_intent_signature":
      return "The agent's NEP-413 signature does not verify.";
    case "nonce_reused":
      return "The request nonce was already used.";
    case "deadline_invalid":
      return `Deadline rejected: ${v.reason}.`;
    case "quote_invalid":
      return `Quote rejected: ${v.reason}.`;
    case "insufficient_treasury_liquidity":
      return `The treasury has only ${n(v.available)} available.`;
    case "recipient_not_allowed":
      return `${who(v.recipient)} on ${v.chain} is not on the approved-recipient list.`;
    case "price_below_floor":
      return "The quoted price is below the DAO's price floor.";
    case "no_price_floor":
      return "The DAO has set no price floor for this pair.";
    case "evm_chain_not_allowed":
      return `EVM chain ${v.chain} is not allowed.`;
    case "evm_asset_not_allowed":
      return `EVM asset ${short(v.asset, 12, 6)} is not allowed.`;
    case "evm_amount_exceeds_limit":
      return "The EVM transfer is above the per-transfer limit.";
    case "evm_epoch_cap_exceeded":
      return "The EVM spending cap for this epoch would be exceeded.";
    case "evm_fee_too_high":
      return "The EVM gas fee is above the fee cap.";
    case "insufficient_agent_balance":
      return `The agent's balance is only ${n(v.balance)}.`;
    case "recipient_blocked":
      return `${who(v.recipient)} on ${v.chain} is on the shared blocklist: ${v.reason}.`;
    case "recipient_needs_approval":
      return `${who(v.recipient)} on ${v.chain} is new: the DAO must approve it first.`;
    case "task_prompt_not_approved":
      return `The task pins a verification prompt (${short(v.prompt_hash, 10, 4)}) that the DAO has not approved.`;
    case "task_floor_below_policy":
      return `The task's ${v.field} of ${v.value} bps is below the DAO's floor of ${v.floor} bps.`;
    case "evm_nonce_mismatch":
      return `EVM nonce ${v.got} is not the next one the treasury signs (${v.expected}).`;
    case "evm_transfer_outstanding":
      return `EVM transfer #${v.tx_id} is still signed and unconfirmed; confirm or cancel it first.`;
    case "invoice_ref_missing":
      return "The DAO requires the vendor's invoice number on every payment.";
    case "invoice_already_paid":
      return `Invoice ${short(v.invoice_ref, 24, 0)} was already paid to this recipient (${v.subject} #${v.subject_id}).`;
  }
}

/**
 * SputnikDAO v2 / Trezu proposal export.
 *
 * Trezu treasuries run on SputnikDAO contracts, so one `add_proposal` payload works for both.
 * The governor (owner) of `phalanx-core` is meant to be such a DAO: these payloads let the
 * multisig approve governance actions (policy changes, revocations, DAO-gated intents) and
 * route revenue-split transfers through the same voting process.
 */
import { formatNear, toBase64, utf8 } from "./encoding.ts";

export interface SputnikFunctionCallAction {
  method_name: string;
  /** base64 of the JSON args */
  args: string;
  deposit: string;
  gas: string;
}

export type SputnikProposalKind =
  | { FunctionCall: { receiver_id: string; actions: SputnikFunctionCallAction[] } }
  | { Transfer: { token_id: string; receiver_id: string; amount: string; msg?: string | null } };

export interface SputnikAddProposal {
  /** Target DAO contract, e.g. `phalanx.sputnikv2.testnet`. */
  daoId: string;
  method: "add_proposal";
  args: { proposal: { description: string; kind: SputnikProposalKind } };
  /** Proposal bond (`policy.proposal_bond`); 1 NEAR is the SputnikDAO v2 default. */
  attachedDeposit: string;
  gas: string;
  /** Ready-to-run near-cli-rs command. */
  cli: string;
}

const DEFAULT_BOND = 10n ** 24n;
const GAS_150_TGAS = "150000000000000";

/**
 * POSIX single-quoted shell word. Descriptions and on-chain labels may contain `'` (the contract's
 * safe-ASCII rule allows it), which would otherwise end the quoting in a copied command.
 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function cliFor(daoId: string, args: unknown, bond: bigint, signer: string): string {
  return [
    "near contract call-function as-transaction",
    daoId,
    "add_proposal",
    `json-args ${shellQuote(JSON.stringify(args))}`,
    "prepaid-gas '150 Tgas'",
    `attached-deposit '${formatNear(bond, 2)} NEAR'`,
    `sign-as ${signer}`,
    "network-config testnet sign-with-keychain send",
  ].join(" ");
}

/** A DAO proposal that calls a method of `phalanx-core` (for example `revoke_agent`). */
export function functionCallProposal(opts: {
  daoId: string;
  contractId: string;
  method: string;
  args: Record<string, unknown>;
  description: string;
  proposer: string;
  gas?: string;
  deposit?: string;
  bond?: bigint;
}): SputnikAddProposal {
  const bond = opts.bond ?? DEFAULT_BOND;
  const args = {
    proposal: {
      description: opts.description,
      kind: {
        FunctionCall: {
          receiver_id: opts.contractId,
          actions: [
            {
              method_name: opts.method,
              args: toBase64(utf8(JSON.stringify(opts.args))),
              deposit: opts.deposit ?? "0",
              gas: opts.gas ?? GAS_150_TGAS,
            },
          ],
        },
      },
    },
  };
  return {
    daoId: opts.daoId,
    method: "add_proposal",
    args,
    attachedDeposit: bond.toString(),
    gas: GAS_150_TGAS,
    cli: cliFor(opts.daoId, args, bond, opts.proposer),
  };
}

/** A DAO proposal that transfers NEAR (`token_id: ""`) from the DAO treasury. */
export function transferProposal(opts: {
  daoId: string;
  receiverId: string;
  amountYocto: bigint;
  description: string;
  proposer: string;
  bond?: bigint;
}): SputnikAddProposal {
  const bond = opts.bond ?? DEFAULT_BOND;
  const args = {
    proposal: {
      description: opts.description,
      kind: { Transfer: { token_id: "", receiver_id: opts.receiverId, amount: opts.amountYocto.toString() } },
    },
  };
  return {
    daoId: opts.daoId,
    method: "add_proposal",
    args,
    attachedDeposit: bond.toString(),
    gas: GAS_150_TGAS,
    cli: cliFor(opts.daoId, args, bond, opts.proposer),
  };
}

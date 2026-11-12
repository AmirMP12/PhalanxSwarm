/** PhalanxSim semantics: access-key enforcement, rollback, refunds, view restrictions, callbacks. */
import { beforeAll, describe, expect, it } from "vitest";

import { ACCOUNTS, ONE_NEAR, SwarmRuntime } from "../src/index.ts";
import { loadContractWasm } from "../src/node.ts";

describe("PhalanxSim NEAR VM", () => {
  let rt: SwarmRuntime;

  beforeAll(async () => {
    rt = await SwarmRuntime.boot({ wasm: loadContractWasm(), intentsMode: "offline" });
    await rt.fund(50, "vm tests");
    for (const p of ["nexus", "cipher", "mallory"] as const) await rt.spawn(p);
  });

  it("creates sub-accounts with a single FunctionCall key and no FullAccess key", () => {
    const keys = rt.keysOf(rt.agents.cipher.accountId);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.permission).toEqual({
      kind: "function_call",
      receiverId: ACCOUNTS.contract,
      methodNames: ["submit_bid", "execute_verified_task", "request_intent_settlement", "request_evm_transfer", "pay_from_balance", "withdraw_earnings"],
      allowance: expect.any(BigInt),
    });
  });

  it("rejects FunctionCall keys outside their method scope before execution", async () => {
    const r = await rt.contract.call(rt.agents.cipher.signer, "distribute_revenue", {}, null);
    expect(r.ok).toBe(false);
    expect(r.outcome).toBeNull();
    expect(r.error).toMatch(/MethodNameMismatch/);
  });

  it("rejects FunctionCall keys that attach a deposit", async () => {
    const r = await rt.contract.call(rt.agents.cipher.signer, "submit_bid", { task_id: "0", action: { type: "commit", commitment: "00".repeat(32) } }, null, {
      deposit: 1n,
    });
    expect(r.error).toMatch(/DepositWithFunctionCall/);
  });

  it("rejects transactions to a different receiver than the key's scope", async () => {
    await expect(rt.vm.functionCall(rt.agents.cipher.signer, ACCOUNTS.operators, "submit_bid", {}, {})).rejects.toThrow(/ReceiverMismatch/);
  });

  it("rolls back state and refunds the deposit when the contract panics", async () => {
    const before = await rt.contract.treasury();
    const balance = rt.vm.balanceOf(ACCOUNTS.customer);
    const r = await rt.contract.call(rt.customer, "deposit_revenue", { customer_ref: "", memo: null }, null, { deposit: 3n * ONE_NEAR });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/PHALANX_E_INVALID_CUSTOMER_REF/);
    expect((await rt.contract.treasury()).liquid).toBe(before.liquid);
    const fee = balance - rt.vm.balanceOf(ACCOUNTS.customer);
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThan(ONE_NEAR / 100n); // only gas was charged, the 3 NEAR came back
  });

  it("prohibits state-changing host functions in views", async () => {
    await expect(rt.vm.view(ACCOUNTS.contract, "fund_treasury", { memo: null })).rejects.toThrow(/ProhibitedInView/);
  });

  it("feeds failed receipts into callbacks: a failed sub-account spawn is rolled back and refunded", async () => {
    const ghost = `ghost-worker.${ACCOUNTS.contract}`;
    rt.vm.createAccount(ghost, ONE_NEAR); // makes CreateAccount fail
    const ownerBefore = rt.vm.balanceOf(ACCOUNTS.owner);
    const r = await rt.contract.call(
      rt.owner,
      "register_and_spawn_agent",
      {
        agent_handle: "ghost-worker",
        role: "compute_worker",
        public_key: "ed25519:8fWHD35Rjd78yeowShh9GwhRudRtLLsGCRjZtgPjAtw9",
        allowance_cap: "1000",
        spawn_mode: "sub_account",
      },
      null,
      { deposit: ONE_NEAR / 2n },
    );
    expect(r.ok).toBe(true);
    const provisioning = r.outcome!.receipts.find((rc) => rc.receiverId === ghost);
    expect(provisioning?.status.type).toBe("Failure");
    expect(r.events.map((e) => e.event)).toContain("agent_spawn_failed");
    expect(await rt.contract.agent(ghost)).toBeNull();
    const spent = ownerBefore - rt.vm.balanceOf(ACCOUNTS.owner);
    expect(spent).toBeLessThan(ONE_NEAR / 100n); // deposit refunded, only gas spent
  });

  it("deletes contract-account keys on quarantine (protocol-level kill switch)", async () => {
    const pk = rt.agents.mallory.keyPair.publicKeyString;
    expect(rt.keysOf(ACCOUNTS.contract).some((k) => k.publicKey === pk)).toBe(true);
    const r = await rt.freeze(rt.agents.mallory.accountId, "test");
    expect(r.ok).toBe(true);
    expect(r.outcome!.receipts.some((rc) => rc.actions.some((a) => a.type === "DeleteKey" && a.publicKey === pk))).toBe(true);
    expect(rt.keysOf(ACCOUNTS.contract).some((k) => k.publicKey === pk)).toBe(false);
    const retry = await rt.contract.call(
      rt.agents.mallory.signer,
      "submit_bid",
      { task_id: "0", action: { type: "commit", commitment: "00".repeat(32) } },
      null,
    );
    expect(retry.error).toMatch(/InvalidAccessKeyError/);
  });

  it("meters gas per host call instead of reporting a flat estimate", async () => {
    // A cheap view and an expensive one must not report the same number: that is what tells a
    // reader the meter is live rather than a constant. nearcore charges per instruction, which a
    // JS host cannot see, so PhalanxSim charges per host call and enforces the prepaid ceiling.
    await rt.vm.view(ACCOUNTS.contract, "contract_info", {});
    const cheap = rt.vm.lastViewGas();
    await rt.vm.view(ACCOUNTS.contract, "get_treasury", {});
    const treasury = rt.vm.lastViewGas();
    await rt.vm.view(ACCOUNTS.contract, "get_dashboard", {});
    const dashboard = rt.vm.lastViewGas();

    expect(cheap).toBeGreaterThan(0n);
    expect(dashboard).toBeGreaterThan(cheap);
    expect(dashboard).toBeGreaterThan(treasury);
    expect(dashboard).toBeLessThan(300n * 10n ** 12n); // a real view fits in one receipt's budget
  });

  it("enforces storage staking (contract balance must cover its bytes)", () => {
    const usage = rt.vm.storageUsage(ACCOUNTS.contract);
    expect(usage).toBeGreaterThan(600_000n);
    expect(rt.vm.balanceOf(ACCOUNTS.contract)).toBeGreaterThan(usage * 10n ** 19n);
  });
});

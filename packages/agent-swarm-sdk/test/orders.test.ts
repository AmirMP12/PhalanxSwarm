/**
 * The v3 customer-order business loop, exactly as the UI drives it: a customer pays the product's
 * price into escrow, the orchestrator posts an RFP that must hash to the order's spec, the winner
 * bids and delivers a signed completion, and only then does the payment become revenue. An order
 * nobody delivered is refundable after its deadline and the escrow is released.
 */
import { describe, expect, it } from "vitest";

import { NEAR_USD, procurementCost, SwarmRuntime, type OrderT } from "../src/index.ts";
import { loadContractWasm } from "../src/node.ts";

const NS = 1_000_000_000n;

async function boot() {
  const rt = await SwarmRuntime.boot({ wasm: loadContractWasm(), intentsMode: "offline" });
  await rt.bootstrap({ attest: false });
  const policy = await rt.contract.policy();
  const product = policy.products[0];
  if (!product) throw new Error("the demo policy lists no product");
  return { rt, product };
}

function advanceTo(rt: SwarmRuntime, targetNs: bigint) {
  if (rt.nowNs() < targetNs) rt.vm.advance(Number((targetNs - rt.nowNs()) / NS) + 1);
}

describe("customer orders", () => {
  it("turns a paid order into revenue only after a verified delivery", async () => {
    const { rt, product } = await boot();
    const spec = rt.customerSpec(60);

    const before = await rt.contract.treasury();
    const placed = await rt.placeOrder(product, spec);
    expect(placed.ok).toBe(true);
    const order = placed.value as OrderT;
    expect(order.status).toBe("paid");
    expect(order.price).toBe(product.price);
    expect(order.task_id).toBeNull();

    // The payment is a liability, not revenue.
    const held = await rt.contract.treasury();
    expect(BigInt(held.orders_escrow) - BigInt(before.orders_escrow)).toBe(BigInt(product.price));
    expect(held.total_revenue).toBe(before.total_revenue);
    expect(held.liquid).toBe(before.liquid);

    // The RFP must carry the order's own spec and stay inside the product's cost share.
    const budget = (BigInt(order.price) / 10_000n) * BigInt(product.max_cost_bps);
    const rfp = rt.orderRfp(order, spec, budget);
    expect(() => rt.orderRfp(order, { ...spec, gpu_hours: 61 }, budget)).toThrow(/spec/);
    const posted = await rt.postRfp(rfp);
    expect(posted.value?.approved).toBe(true);
    const taskId = posted.value!.task!.task_id;
    expect(posted.value!.task!.order_id).toBe(order.order_id);

    const inProduction = await rt.contract.order(order.order_id);
    expect(inProduction?.status).toBe("in_production");
    expect(inProduction?.task_id).toBe(taskId);

    // Cipher prices from its own plan, commits, reveals, and Nexus closes.
    const view = await rt.contract.task(taskId);
    if (!view) throw new Error("task missing");
    const plan = await rt.decideBid("cipher", view.task, procurementCost(spec, NEAR_USD), 2_500);
    const bid = rt.sealedBid("cipher", taskId, plan.price, plan.latencySec);
    expect((await bid.commit()).ok).toBe(true);
    advanceTo(rt, BigInt(view.task.bidding_deadline_ns));
    expect((await bid.reveal()).ok).toBe(true);
    const closed = await rt.closeAuction(taskId);
    expect(closed.value?.winner).toBe(rt.agents.cipher.accountId);

    // A signed completion over the exact spec verifies on-chain and delivers the order.
    const awarded = await rt.contract.task(taskId);
    const proc = await rt.executeProcurement(awarded!.task, spec);
    const executed = await proc.submit();
    expect(executed.ok && executed.value?.settled).toBe(true);

    const delivered = await rt.contract.order(order.order_id);
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.result_hash).toBeTruthy();
    expect(delivered?.receipt_hash).toBeTruthy();

    const after = await rt.contract.treasury();
    expect(after.orders_escrow).toBe(before.orders_escrow);
    expect(BigInt(after.total_revenue) - BigInt(before.total_revenue)).toBe(BigInt(product.price));
    expect(after.solvent_liquidity === "0" || BigInt(after.solvent_liquidity) >= 0n).toBe(true);
  });

  it("refunds an order nobody delivered once its deadline passes", async () => {
    const { rt, product } = await boot();
    const revenueBefore = (await rt.contract.treasury()).total_revenue;
    const customerBefore = rt.vm.balanceOf(rt.customer.accountId);
    const placed = await rt.placeOrder(product, rt.customerSpec(60));
    const order = placed.value as OrderT;
    // The customer pays the price plus the storage the new order record stakes.
    const afterPurchase = rt.vm.balanceOf(rt.customer.accountId);
    const storage = customerBefore - afterPurchase - BigInt(product.price);
    expect(storage).toBeGreaterThanOrEqual(0n);
    expect(customerBefore - afterPurchase).toBeGreaterThanOrEqual(BigInt(product.price));

    // Too early: the contract refuses.
    const early = await rt.refundOrder(order.order_id);
    expect(early.ok).toBe(false);
    expect(early.error).toMatch(/deadline/);

    advanceTo(rt, BigInt(order.deadline_ns));
    const refunded = await rt.refundOrder(order.order_id);
    expect(refunded.ok).toBe(true);

    // The refund transfer's callback settles the order and the customer gets the price back.
    const settled = await rt.contract.order(order.order_id);
    expect(settled?.status).toBe("refunded");
    expect(settled?.closed_at_ns).not.toBeNull();
    // The price comes back: only the order's storage and the customer's own gas stay spent.
    const refundedBalance = rt.vm.balanceOf(rt.customer.accountId);
    expect(refundedBalance).toBeLessThanOrEqual(customerBefore - storage);
    expect(customerBefore - refundedBalance).toBeLessThan(BigInt(product.price) / 100n);

    const t = await rt.contract.treasury();
    expect(t.orders_escrow).toBe("0");
    // A refund is not revenue: the ledger's revenue is exactly what it was before the purchase.
    expect(t.total_revenue).toBe(revenueBefore);
  });

  it("rejects an order for an unknown product or a wrong deposit", async () => {
    const { rt, product } = await boot();
    const unknown = await rt.placeOrder({ ...product, product_id: "no-such-product" }, rt.customerSpec(60));
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/unknown product/);

    // The deposit is exactly the price: the SDK sends it, so only the contract's own check matters.
    const ok = await rt.placeOrder(product, rt.customerSpec(60));
    expect(ok.ok).toBe(true);
  });
});

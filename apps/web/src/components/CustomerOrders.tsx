"use client";

import { NEAR_USD, procurementCost, type OrderT, type ProductT, type ProcurementSpec, type SwarmRuntime } from "@phalanx/agent-swarm-sdk";
import { ArrowRight, BadgeCheck, Ban, Boxes, Clock3, Gavel, PackageCheck, RotateCcw, ShoppingCart, Store, Undo2, Wallet } from "lucide-react";
import { useState } from "react";

import { usePhalanx } from "@/lib/phalanx-context";
import { useAction } from "@/lib/use-action";

import {
  Badge,
  Button,
  Card,
  CardHeader,
  Callout,
  EmptyState,
  KV,
  Label,
  SkeletonBlock,
  cx,
  describeViolation,
  nearFmt,
  short,
  useCommands,
  type Tone,
} from "./ui";

const NS = 1_000_000_000n;

const orderTone = (s: OrderT["status"]): Tone =>
  s === "delivered" ? "emerald" : s === "refunded" ? "slate" : s === "refunding" ? "amber" : s === "in_production" ? "sky" : "violet";

/** The sandbox-clock advance a sealed auction needs before the reveal and close phases open. */
function secondsUntil(target: bigint, now: bigint): number {
  return target <= now ? 0 : Number((target - now) / NS) + 1;
}

interface Flow {
  runtime: SwarmRuntime;
  order: OrderT;
  /** The exact document hashed into `place_order`: the RFP and the proof must carry it. */
  spec: ProcurementSpec;
}

/**
 * The business loop of v3: a customer buys a product, the swarm procures exactly that spec through
 * the auction market, and a verified delivery turns the payment (a liability in `orders_escrow`)
 * into revenue. Every step is the contract's: the price is exact, the RFP must hash to the order's
 * spec with a pinned prompt and stay inside the product's cost share, and an undelivered order is
 * refundable only after its deadline.
 */
export function CustomerOrders() {
  const { runtime, dashboard, busy } = usePhalanx();
  const action = useAction();
  const [flowState, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  // A restarted sandbox (or a different runtime) invalidates the in-flight order.
  const flow = flowState && flowState.runtime === runtime ? flowState : null;

  const products = dashboard?.policy.products ?? [];
  const orders = dashboard?.orders ?? [];
  const escrow = dashboard?.treasury.orders_escrow ?? "0";
  const disabled = busy !== null || working !== null || !runtime;

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

  const reload = async (orderId: string) => {
    if (!runtime) return;
    const fresh = await runtime.contract.order(orderId);
    if (fresh) setFlow((f) => (f ? { ...f, order: fresh } : f));
  };

  /** Step 1 — the customer pays exactly the product's price; only the spec hash goes on-chain. */
  const buy = (product: ProductT) =>
    run(`buying ${product.product_id}`, async () => {
      if (!runtime) return;
      const spec = runtime.customerSpec(60);
      const r = await action(
        `customer buys ${product.title}`,
        runtime.customer,
        "place_order",
        (rt) => rt.placeOrder(product, spec),
        (res) =>
          res.ok && res.value
            ? {
                tone: "success",
                title: `Order #${res.value.order_id} placed`,
                description: `${nearFmt(res.value.price)} held in orders_escrow until a verified task delivers it`,
              }
            : undefined,
      );
      if (r?.ok && r.value) setFlow({ runtime, order: r.value, spec });
    });

  /** Step 2 — Nexus turns the order into an RFP; the contract checks spec, prompt pin and cost share. */
  const procure = () =>
    run("posting the order's RFP", async () => {
      if (!runtime || !flow) return;
      const product = products.find((p) => p.product_id === flow.order.product_id);
      const bps = BigInt(product?.max_cost_bps ?? 10_000);
      // Same integer arithmetic as `link_order`: price / 10_000 * max_cost_bps.
      const budget = (BigInt(flow.order.price) / 10_000n) * bps;
      const rfp = runtime.orderRfp(flow.order, flow.spec, budget);
      const r = await action(
        "Nexus posts the order's RFP",
        runtime.agents.nexus.signer,
        "post_task_rfp",
        (rt) => rt.postRfp(rfp),
        (res) =>
          res.ok && res.value?.approved === false
            ? {
                tone: "error",
                title: "The policy engine rejected the RFP",
                description: res.value.violations.map(describeViolation).join(" · ") || res.value.severity,
              }
            : undefined,
      );
      if (r?.ok && r.value?.approved) await reload(flow.order.order_id);
    });

  /** Step 3 — Cipher prices from its own cost model, commits a sealed bid, reveals, Nexus closes. */
  const auction = () =>
    run("running the auction", async () => {
      if (!runtime || !flow?.order.task_id) return;
      const taskId = flow.order.task_id;
      const view = await runtime.contract.task(taskId);
      if (!view) throw new Error(`task #${taskId} not found`);
      const plan = await runtime.decideBid("cipher", view.task, procurementCost(flow.spec, NEAR_USD), 2_500);
      const bid = runtime.sealedBid("cipher", taskId, plan.price, plan.latencySec);
      const commit = await action(
        "Cipher commits a sealed bid",
        runtime.agents.cipher.signer,
        "submit_bid",
        () => bid.commit(),
        () => null,
      );
      if (!commit?.ok) throw new Error(commit?.error ?? "commit failed");
      // The sandbox clock is explicit: the bidding window has to pass before the reveal.
      const wait = secondsUntil(BigInt(view.task.bidding_deadline_ns), runtime.nowNs());
      if (wait > 0) runtime.vm.advance(wait);
      const reveal = await action(
        "Cipher reveals its price",
        runtime.agents.cipher.signer,
        "submit_bid",
        () => bid.reveal(),
        () => null,
      );
      if (!reveal?.ok) throw new Error(reveal?.error ?? "reveal failed");
      const closed = await action("Nexus closes the sealed auction", runtime.agents.nexus.signer, "close_auction", (rt) => rt.closeAuction(taskId));
      if (!closed?.ok) throw new Error(closed?.error ?? "close failed");
      await reload(flow.order.order_id);
    });

  /** Step 4 — the winner's signed completion verifies on-chain: escrow becomes revenue. */
  const deliver = () =>
    run("delivering the order", async () => {
      if (!runtime || !flow?.order.task_id) return;
      const view = await runtime.contract.task(flow.order.task_id);
      if (!view) throw new Error(`task #${flow.order.task_id} not found`);
      const proc = await runtime.executeProcurement(view.task, flow.spec);
      const r = await action(
        "Cipher submits its signed completion",
        runtime.agents.cipher.signer,
        "execute_verified_task",
        () => proc.submit(),
        (res) =>
          res.ok && res.value?.settled
            ? { tone: "success", title: `Order #${flow.order.order_id} delivered`, description: "Escrow released, the payment is booked as revenue" }
            : undefined,
      );
      if (!r?.ok) throw new Error(r?.error ?? r?.value?.error ?? "the proof did not verify");
      await reload(flow.order.order_id);
    });

  /** Refund — only after the delivery deadline, and only for an order the swarm never procured. */
  const refund = () =>
    run("refunding the order", async () => {
      if (!runtime || !flow) return;
      const deadline = BigInt(flow.order.deadline_ns);
      const wait = secondsUntil(deadline, runtime.nowNs());
      if (wait > 0) runtime.vm.advance(wait);
      const r = await action("anyone refunds the overdue order", runtime.customer, "refund_order", (rt) => rt.refundOrder(flow.order.order_id));
      if (!r?.ok) throw new Error(r?.error ?? "refund failed");
      await reload(flow.order.order_id);
    });

  useCommands(
    () => [
      {
        id: "orders-buy",
        group: "Customer orders",
        title: products[0] ? `Buy ${products[0].title}` : "Buy the product",
        subtitle: "place_order: the customer pays exactly the price; it is escrow, not revenue",
        icon: ShoppingCart,
        disabled: disabled || !products[0] || flow !== null,
        disabledReason: flow ? "Finish or dismiss the order in flight first" : "Busy",
        run: () => products[0] && void buy(products[0]),
      },
      ...(flow && flow.order.task_id === null && flow.order.status === "paid"
        ? [
            {
              id: "orders-procure",
              group: "Customer orders",
              title: `Post the RFP for order #${flow.order.order_id}`,
              subtitle: "The RFP must hash to the order's spec, pin a DAO-approved prompt and stay inside its cost share",
              icon: Boxes,
              disabled,
              disabledReason: "Busy",
              run: () => void procure(),
            },
          ]
        : []),
      ...(flow && flow.order.task_id && flow.order.status === "in_production"
        ? [
            {
              id: "orders-auction",
              group: "Customer orders",
              title: `Run the auction for order #${flow.order.order_id}`,
              subtitle: "Cipher commits a sealed bid from its cost model, reveals, Nexus closes",
              icon: Gavel,
              disabled,
              disabledReason: "Busy",
              run: () => void auction(),
            },
            {
              id: "orders-deliver",
              group: "Customer orders",
              title: `Deliver order #${flow.order.order_id}`,
              subtitle: "Cipher's signed completion verifies on-chain; escrow becomes revenue",
              icon: PackageCheck,
              disabled,
              disabledReason: "Busy",
              run: () => void deliver(),
            },
          ]
        : []),
    ],
    [disabled, products, flow, runtime],
  );

  if (!runtime || !dashboard)
    return (
      <Card className="p-4 sm:p-5">
        <CardHeader icon={Store} eyebrow="Customers · orders · escrow → revenue" title="Customer orders" />
        <div className="mt-5">
          <SkeletonBlock rows={6} />
        </div>
      </Card>
    );

  const s = flow?.order ?? null;
  // The catalogue's first product: the demo's default purchase (narrowed once, not inside a handler).
  const featured = products[0] ?? null;
  const taskId = s?.task_id ?? null;
  const task = taskId ? dashboard.tasks.find((t) => t.task.task_id === taskId)?.task : undefined;
  const product = s ? products.find((p) => p.product_id === s.product_id) : undefined;
  const canRefund = s !== null && s.status === "paid" && taskId === null;
  const deadlinePassed = s !== null && runtime.nowNs() > BigInt(s.deadline_ns);

  const steps = [
    { key: "paid", label: "Customer pays", done: s !== null },
    { key: "procure", label: "RFP posted", done: taskId !== null },
    { key: "auction", label: "Auction cleared", done: task?.winner != null },
    { key: "deliver", label: "Delivered", done: s?.status === "delivered" },
  ];

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader
        icon={Store}
        eyebrow="place_order · link_order · deliver_order · refund_order"
        title="Customer orders"
        description="A customer buys a product from the DAO's on-chain catalogue. The payment is a liability in orders_escrow, never revenue, until a verified task delivers exactly the spec the customer hashed. An order nobody delivered is refundable by anyone after its deadline."
        actions={
          dashboard && (
            <>
              <Badge tone={BigInt(escrow) > 0n ? "amber" : "slate"} icon={Wallet}>
                <span className="num">{nearFmt(escrow)} in orders escrow</span>
              </Badge>
              <Badge tone="slate">
                {orders.length} {orders.length === 1 ? "order" : "orders"}
              </Badge>
            </>
          )
        }
      />

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>Product catalogue (GlobalPolicy.products)</Label>
            {!s && featured && (
              <Button size="sm" variant="primary" icon={ShoppingCart} disabled={disabled} onClick={() => void buy(featured)}>
                Buy {featured.title}
              </Button>
            )}
          </div>
          {products.length === 0 ? (
            <EmptyState
              icon={Store}
              title="No products listed"
              hint="The DAO sets GlobalPolicy.products; an order for an unlisted product is rejected."
              className="mt-3"
            />
          ) : (
            <ul className="mt-3 space-y-2">
              {products.map((p) => (
                <li key={p.product_id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-slate-100">{p.title}</div>
                      <div className="num text-[11px] text-slate-500">{p.product_id}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="emerald" className="num">
                        {nearFmt(p.price)} exact
                      </Badge>
                      <Badge tone="slate" icon={Clock3}>
                        {Math.round(p.delivery_sec / 60)} min deadline
                      </Badge>
                    </div>
                  </div>
                  <p className="num mt-1.5 text-[11px] text-slate-500">
                    at most {p.max_cost_bps / 100}% of the price may be spent on the procuring task (
                    {nearFmt((BigInt(p.price) / 10_000n) * BigInt(p.max_cost_bps))}) · anything above is rejected when the order is linked
                  </p>
                  {!s && (
                    <Button className="mt-2" size="sm" icon={ShoppingCart} disabled={disabled} onClick={() => void buy(p)}>
                      Customer buys (place_order)
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

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

          {s ? (
            <div className="mt-4 rounded-xl border border-white/[0.07] bg-black/20 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="num text-[13px] font-semibold text-white">Order #{s.order_id}</span>
                  <Badge tone={orderTone(s.status)} dot>
                    {s.status.replace("_", " ")}
                  </Badge>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={RotateCcw}
                  disabled={disabled}
                  onClick={() => {
                    setError(null);
                    setFlow(null);
                  }}
                >
                  Dismiss
                </Button>
              </div>

              <ol className="mt-3 grid grid-cols-4 gap-1.5 text-[10.5px]" aria-label="Order progress">
                {steps.map((st) => (
                  <li
                    key={st.key}
                    className={cx(
                      "flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-center",
                      st.done ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : "border-white/[0.07] bg-white/[0.02] text-slate-500",
                    )}
                  >
                    {st.done ? <BadgeCheck className="size-3 shrink-0" aria-hidden /> : <ArrowRight className="size-3 shrink-0 opacity-40" aria-hidden />}
                    <span className="truncate">{st.label}</span>
                  </li>
                ))}
              </ol>

              <div className="mt-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-1">
                <KV k="customer" v={<span title={s.customer}>{short(s.customer, 22, 0)}</span>} />
                <KV k="product" v={product?.title ?? s.product_id} />
                <KV k="price (escrowed)" v={nearFmt(s.price)} />
                <KV k="spec hash (sha256 of the document)" v={<span title={s.spec_hash}>{short(s.spec_hash, 14, 8)}</span>} />
                <KV k="task" v={taskId ? `#${taskId}` : "not procured"} />
                <KV
                  k="deadline"
                  v={
                    <span className={deadlinePassed && s.status !== "delivered" ? "text-amber-200" : undefined}>
                      {deadlinePassed ? "passed" : `${Math.max(1, Math.round(secondsUntil(BigInt(s.deadline_ns), runtime.nowNs()) / 60))} min left`}
                    </span>
                  }
                />
                {s.failed_tasks.length > 0 && <KV k="failed tasks" v={s.failed_tasks.map((t) => `#${t}`).join(", ")} />}
                {s.result_hash && <KV k="result hash (delivered)" v={<span title={s.result_hash}>{short(s.result_hash, 14, 8)}</span>} />}
                {s.receipt_hash && <KV k="proof receipt" v={<span title={s.receipt_hash}>{short(s.receipt_hash, 14, 8)}</span>} />}
                {task?.winning_price && <KV k="winning price" v={`${nearFmt(task.winning_price)} (ceiling ${nearFmt(task.budget_ceiling)})`} />}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {s.status === "paid" && taskId === null && (
                  <Button size="sm" variant="primary" icon={Boxes} disabled={disabled} onClick={() => void procure()}>
                    2 · Nexus posts the order&apos;s RFP
                  </Button>
                )}
                {s.status === "in_production" && taskId !== null && !task?.winner && (
                  <Button size="sm" variant="primary" icon={Gavel} disabled={disabled} onClick={() => void auction()}>
                    3 · Run the sealed auction
                  </Button>
                )}
                {s.status === "in_production" && taskId !== null && task?.winner && (
                  <Button size="sm" variant="primary" icon={PackageCheck} disabled={disabled} onClick={() => void deliver()}>
                    4 · Cipher delivers
                  </Button>
                )}
                {canRefund && (
                  <Button size="sm" variant="danger" icon={Undo2} disabled={disabled} onClick={() => void refund()}>
                    Refund after the deadline
                  </Button>
                )}
                {s.status === "delivered" && (
                  <span className="flex items-center gap-1.5 text-[12px] text-emerald-300">
                    <BadgeCheck className="size-4" aria-hidden /> Paid out of escrow into revenue; the DAO splits it.
                  </span>
                )}
                {s.status === "refunded" && (
                  <span className="flex items-center gap-1.5 text-[12px] text-slate-400">
                    <Undo2 className="size-4" aria-hidden /> Refunded in full; orders_escrow is released.
                  </span>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-white/[0.08] p-3 text-[12px] text-slate-500">
              No order in flight. A purchase stakes the price in <span className="num">orders_escrow</span>; procurement spending is capped at the
              product&apos;s cost share, so a sale always leaves a margin.
            </p>
          )}
        </div>

        <div className="min-w-0">
          <Label className="mb-2">Order book (list_orders, newest first)</Label>
          {orders.length === 0 ? (
            <EmptyState icon={Boxes} title="No orders yet" hint="Buy the product to start the business loop." />
          ) : (
            <ul tabIndex={0} aria-label="Customer orders" className="fade-bottom max-h-[330px] space-y-1.5 overflow-y-auto pb-3 pr-1">
              {orders.map((o) => (
                <li key={o.order_id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="num text-slate-200">#{o.order_id}</span>
                    <Badge tone={orderTone(o.status)} dot>
                      {o.status.replace("_", " ")}
                    </Badge>
                  </div>
                  <div className="num mt-1 flex flex-wrap justify-between gap-x-3 text-[11px] text-slate-500">
                    <span className="text-slate-300">{nearFmt(o.price)}</span>
                    <span title={o.customer}>{short(o.customer, 18, 0)}</span>
                    <span>{o.task_id ? `task #${o.task_id}` : "unprocured"}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            escrow held for undelivered orders <span className="num text-slate-300">{nearFmt(escrow)}</span> · every delivery moves its price from escrow into
            revenue and every refund returns it to the customer.
          </p>
        </div>
      </div>
    </Card>
  );
}

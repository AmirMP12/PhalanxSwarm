//! Customer orders: what the autonomous business sells (track: business).
//!
//! The DAO lists products in `GlobalPolicy.products`. A customer buys one with `place_order`,
//! attaching the exact price and the sha256 of its spec. The payment is held as an obligation
//! (`Treasury.orders_escrow`), not as revenue, until the swarm delivers:
//!
//! * the orchestrator posts an RFP for the order (`TaskRfpInput.order_id`). Its spec must be the
//!   order's spec, its proof must use a pinned prompt over that exact spec (`input_pinned`), and its
//!   budget may use at most `max_cost_bps` of the price, so every sale leaves a margin;
//! * the winner's verified TEE proof releases its escrow and delivers the order in the same call:
//!   the price becomes revenue and the hash of the signed model output is recorded for the customer;
//! * if the winner fails or misses its deadline, the order reopens and can be procured again;
//! * if nothing is delivered by the order's deadline, anyone calls `refund_order` and the customer
//!   gets the full price back.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

use crate::codec::{is_lower_hash32_hex, is_safe_ascii};
use crate::events::PhalanxEvent;
use crate::swarm_market::{TaskRfp, TaskRfpInput};
use crate::{PhalanxCore, PhalanxCoreExt};

pub const MAX_PRODUCTS: usize = 8;
/// Orders that are paid but not delivered or refunded, at most.
pub const MAX_OPEN_ORDERS: u32 = 32;
const NS: u64 = 1_000_000_000;

/// Something the business sells, at a fixed price.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Product {
    /// `[a-z0-9-]`, 2 to 32 characters.
    pub product_id: String,
    pub title: String,
    /// yoctoNEAR the customer attaches.
    pub price: U128,
    /// Seconds from purchase to the delivery deadline; after it the customer can take a refund.
    pub delivery_sec: u64,
    /// Share of the price the swarm may spend on the task, basis points.
    pub max_cost_bps: u32,
}

impl Product {
    pub fn validate(&self) {
        let id_ok = (2..=32).contains(&self.product_id.len())
            && self.product_id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-');
        require!(id_ok, "PHALANX_E_POLICY: product_id is 2-32 chars of [a-z0-9-]");
        require!(!self.title.is_empty() && is_safe_ascii(&self.title, 64), "PHALANX_E_POLICY: product title");
        require!(self.price.0 > 0, "PHALANX_E_POLICY: product price must be > 0");
        require!((60..=2_592_000).contains(&self.delivery_sec), "PHALANX_E_POLICY: delivery_sec must be 60..=2592000");
        require!((1..=10_000).contains(&self.max_cost_bps), "PHALANX_E_POLICY: max_cost_bps must be 1..=10000");
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    /// Paid; no task is working on it.
    Paid,
    /// A task is procuring it.
    InProduction,
    Delivered,
    /// The refund transfer is in flight.
    Refunding,
    Refunded,
}

impl OrderStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            OrderStatus::Paid => "paid",
            OrderStatus::InProduction => "in_production",
            OrderStatus::Delivered => "delivered",
            OrderStatus::Refunding => "refunding",
            OrderStatus::Refunded => "refunded",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub order_id: U64,
    pub customer: AccountId,
    pub product_id: String,
    pub price: U128,
    /// Hex sha256 of the customer's spec. The delivering task's model must answer exactly this spec.
    pub spec_hash: String,
    pub placed_at_ns: U64,
    pub deadline_ns: U64,
    pub status: OrderStatus,
    /// The task procuring the order now (or the one that delivered it).
    pub task_id: Option<U64>,
    /// Tasks that worked on the order and failed.
    pub failed_tasks: Vec<U64>,
    /// Hex sha256 of the TEE-signed model output that delivered the order.
    pub result_hash: Option<String>,
    /// Hash of the verified proof (see `list_attestations`).
    pub receipt_hash: Option<String>,
    pub closed_at_ns: Option<U64>,
}

impl PhalanxCore {
    pub(crate) fn order_or_panic(&self, order_id: u64) -> Order {
        self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("PHALANX_E_UNKNOWN_ORDER"))
    }

    /// `post_task_rfp` for an order: checks the RFP against the order and marks it in production.
    pub(crate) fn link_order(&mut self, rfp: &TaskRfpInput, task_id: u64) {
        let Some(order_id) = rfp.order_id else {
            return;
        };
        let mut order = self.order_or_panic(order_id.0);
        require!(order.status == OrderStatus::Paid, "PHALANX_E_ORDER: not open for procurement");
        require!(env::block_timestamp() < order.deadline_ns.0, "PHALANX_E_ORDER: delivery deadline passed");
        require!(rfp.spec_hash.to_lowercase() == order.spec_hash, "PHALANX_E_ORDER: the RFP spec must be the order's spec");
        require!(
            rfp.verification.input_pinned && rfp.verification.prompt_hash.is_some(),
            "PHALANX_E_ORDER: the proof must use a pinned prompt over the order's spec (input_pinned)"
        );
        let product = self.policy.products.iter().find(|p| p.product_id == order.product_id);
        let max_cost_bps = product.map(|p| p.max_cost_bps).unwrap_or(10_000);
        let max_cost = order.price.0 / 10_000 * u128::from(max_cost_bps);
        require!(rfp.budget_ceiling.0 <= max_cost, "PHALANX_E_ORDER: budget exceeds the product's cost share");
        order.status = OrderStatus::InProduction;
        order.task_id = Some(U64(task_id));
        self.orders.insert(order_id.0, order);
        PhalanxEvent::OrderInProduction { order_id, task_id: U64(task_id) }.emit();
    }

    /// A verified delivery for the order's task: the price becomes revenue.
    pub(crate) fn deliver_order(&mut self, task: &TaskRfp, output_hash: &str, receipt_hash: &str) {
        let Some(order_id) = task.order_id else {
            return;
        };
        let Some(mut order) = self.orders.get(&order_id.0).cloned() else {
            return;
        };
        let now = env::block_timestamp();
        if order.status != OrderStatus::InProduction || order.task_id != Some(task.task_id) || now > order.deadline_ns.0 {
            return;
        }
        let price = order.price.0;
        self.treasury.orders_escrow -= price;
        self.treasury.liquid += price;
        self.treasury.total_revenue += price;
        self.open_orders = self.open_orders.saturating_sub(1);
        order.status = OrderStatus::Delivered;
        order.result_hash = Some(output_hash.to_string());
        order.receipt_hash = Some(receipt_hash.to_string());
        order.closed_at_ns = Some(U64(now));
        self.orders.insert(order_id.0, order.clone());
        PhalanxEvent::OrderDelivered {
            order_id,
            customer: order.customer,
            task_id: task.task_id,
            price: order.price,
            result_hash: output_hash.to_string(),
        }
        .emit();
    }

    /// The order's task failed, expired or was cancelled: the order can be procured again.
    pub(crate) fn reopen_order(&mut self, task: &TaskRfp) {
        let Some(order_id) = task.order_id else {
            return;
        };
        let Some(mut order) = self.orders.get(&order_id.0).cloned() else {
            return;
        };
        if order.status != OrderStatus::InProduction || order.task_id != Some(task.task_id) {
            return;
        }
        order.status = OrderStatus::Paid;
        order.task_id = None;
        order.failed_tasks.push(task.task_id);
        self.orders.insert(order_id.0, order);
        PhalanxEvent::OrderReopened { order_id, failed_task_id: task.task_id }.emit();
    }
}

#[near]
impl PhalanxCore {
    /// A customer buys a product: attach exactly its price, and name the sha256 of the spec.
    #[payable]
    pub fn place_order(&mut self, product_id: String, spec_hash: String) -> Order {
        require!(!self.paused, "PHALANX_E_PAUSED");
        let product = self
            .policy
            .products
            .iter()
            .find(|p| p.product_id == product_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("PHALANX_E_ORDER: unknown product"));
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid == product.price.0, "PHALANX_E_ORDER: attach exactly the product price");
        require!(is_lower_hash32_hex(&spec_hash), "PHALANX_E_ORDER: spec_hash must be 32-byte lower-case hex");
        require!(self.open_orders < MAX_OPEN_ORDERS, "PHALANX_E_ORDER: too many open orders");
        let customer = env::predecessor_account_id();
        require!(customer != env::current_account_id(), "PHALANX_E_ORDER: the treasury cannot buy from itself");
        let now = env::block_timestamp();
        let order_id = self.next_order_id;
        self.next_order_id += 1;
        let order = Order {
            order_id: U64(order_id),
            customer: customer.clone(),
            product_id,
            price: product.price,
            spec_hash,
            placed_at_ns: U64(now),
            deadline_ns: U64(now + product.delivery_sec * NS),
            status: OrderStatus::Paid,
            task_id: None,
            failed_tasks: vec![],
            result_hash: None,
            receipt_hash: None,
            closed_at_ns: None,
        };
        self.treasury.orders_escrow += paid;
        self.open_orders += 1;
        self.orders.insert(order_id, order.clone());
        PhalanxEvent::OrderPlaced {
            order_id: U64(order_id),
            customer,
            product_id: order.product_id.clone(),
            price: order.price,
            spec_hash: order.spec_hash.clone(),
            deadline_ns: order.deadline_ns,
        }
        .emit();
        order
    }

    /// Anyone refunds an order that was not delivered by its deadline: the customer gets the
    /// full price back.
    pub fn refund_order(&mut self, order_id: U64) -> Order {
        let mut order = self.order_or_panic(order_id.0);
        require!(matches!(order.status, OrderStatus::Paid | OrderStatus::InProduction), "PHALANX_E_ORDER: not refundable");
        require!(env::block_timestamp() > order.deadline_ns.0, "PHALANX_E_ORDER: the delivery deadline has not passed");
        self.treasury.orders_escrow -= order.price.0;
        self.open_orders = self.open_orders.saturating_sub(1);
        order.status = OrderStatus::Refunding;
        self.orders.insert(order_id.0, order.clone());
        Promise::new(order.customer.clone())
            .transfer(NearToken::from_yoctonear(order.price.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(self.config.callback_gas_tgas))
                    .on_order_refund(order_id),
            )
            .detach();
        order
    }

    /// Callback of the refund transfer. A bounced refund puts the order back, refundable again.
    #[private]
    pub fn on_order_refund(&mut self, order_id: U64) -> Order {
        require!(env::promise_results_count() == 1, "PHALANX_E_CALLBACK_ONLY");
        let mut order = self.order_or_panic(order_id.0);
        require!(order.status == OrderStatus::Refunding, "PHALANX_E_ORDER: not refunding");
        if env::promise_result_checked(0, 64).is_ok() {
            order.status = OrderStatus::Refunded;
            order.closed_at_ns = Some(U64(env::block_timestamp()));
            PhalanxEvent::OrderRefunded { order_id, customer: order.customer.clone(), amount: order.price }.emit();
        } else {
            order.status = OrderStatus::Paid;
            order.task_id = None;
            self.treasury.orders_escrow += order.price.0;
            self.open_orders += 1;
        }
        self.orders.insert(order_id.0, order.clone());
        order
    }

    pub fn get_order(&self, order_id: U64) -> Option<Order> {
        self.orders.get(&order_id.0).cloned()
    }

    /// Newest first.
    pub fn list_orders(&self, limit: Option<u32>) -> Vec<Order> {
        let limit = u64::from(limit.unwrap_or(20).min(crate::MAX_PAGE));
        let end = self.next_order_id;
        (end.saturating_sub(limit)..end).rev().filter_map(|id| self.orders.get(&id).cloned()).collect()
    }
}

//! Duplicate-invoice protection (tracks: security, realworld).
//!
//! A vendor payment or EVM transfer can name the vendor's invoice (`invoice_ref`). The contract
//! records `(chain, recipient, invoice_ref)` when it approves the payment and refuses a second
//! payment for the same key (`invoice_already_paid`), whichever agent asks. The record is removed
//! again when the payment does not happen (a bounced transfer, a failed MPC signature, a cancel),
//! so an honest retry after a failure works.
//!
//! With `GlobalPolicy.require_invoice_ref` (the default), every vendor payment and EVM transfer
//! must carry one (`invoice_ref_missing`). Both findings are `notice`: the payment is refused and
//! the agent keeps its key, because a duplicate is usually an honest retry or two agents handling
//! the same invoice. Invoice numbers are written by the paying agent, so this stops accidental
//! double payment, not an attacker who invents new numbers; the caps limit that case.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

use crate::codec::{is_safe_ascii, recipient_key};
use crate::{PhalanxCore, PhalanxCoreExt};

/// Longest accepted invoice number.
pub const MAX_INVOICE_REF: usize = 64;

/// A payment the contract made, or is making, for one invoice.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvoicePayment {
    pub invoice_ref: String,
    /// `<chain>:<address>`, EVM addresses lower-case.
    pub recipient: String,
    /// `intent` (settlement) or `evm` (EVM transfer), and its id.
    pub subject: String,
    pub subject_id: U64,
    pub amount: U128,
    pub agent_id: AccountId,
    pub at_ns: U64,
}

/// 1 to 64 printable ASCII characters.
pub fn is_valid_invoice_ref(r: &str) -> bool {
    !r.is_empty() && is_safe_ascii(r, MAX_INVOICE_REF)
}

/// Storage key of an invoice: `<chain>:<recipient>:<invoice_ref>`. Chain ids and recipients
/// contain no `:`, so the key is unambiguous.
pub fn invoice_key(chain: &str, recipient: &str, invoice_ref: &str) -> String {
    format!("{}:{}", recipient_key(chain, recipient), invoice_ref)
}

impl PhalanxCore {
    /// The payment already recorded for this invoice, if any.
    pub(crate) fn invoice_payment(&self, chain: &str, recipient: &str, invoice_ref: &str) -> Option<InvoicePayment> {
        self.invoices.get(&invoice_key(chain, recipient, invoice_ref)).cloned()
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_invoice(
        &mut self,
        chain: &str,
        recipient: &str,
        invoice_ref: &str,
        subject: &str,
        subject_id: u64,
        amount: u128,
        agent_id: &AccountId,
    ) {
        let payment = InvoicePayment {
            invoice_ref: invoice_ref.to_string(),
            recipient: recipient_key(chain, recipient),
            subject: subject.to_string(),
            subject_id: U64(subject_id),
            amount: U128(amount),
            agent_id: agent_id.clone(),
            at_ns: U64(env::block_timestamp()),
        };
        self.invoices.insert(invoice_key(chain, recipient, invoice_ref), payment);
    }

    /// Forgets an invoice whose payment did not happen, if `subject:subject_id` still holds it.
    pub(crate) fn release_invoice(
        &mut self,
        chain: &str,
        recipient: &str,
        invoice_ref: Option<&str>,
        subject: &str,
        subject_id: u64,
    ) {
        let Some(invoice_ref) = invoice_ref else {
            return;
        };
        let key = invoice_key(chain, recipient, invoice_ref);
        if self.invoices.get(&key).is_some_and(|p| p.subject == subject && p.subject_id.0 == subject_id) {
            self.invoices.remove(&key);
        }
    }
}

#[near]
impl PhalanxCore {
    /// The payment recorded for `invoice_ref` to `recipient` on `chain`, so an agent can check an
    /// invoice before it pays it.
    pub fn get_invoice_payment(&self, chain: String, recipient: String, invoice_ref: String) -> Option<InvoicePayment> {
        self.invoice_payment(&chain, &recipient, &invoice_ref)
    }
}

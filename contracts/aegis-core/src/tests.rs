//! Unit tests against near-sdk's mocked blockchain (nearcore host functions).
//!
//! Sandbox integration tests that deploy the compiled WASM to a real local node live in
//! `contracts/aegis-sandbox-tests` (near-workspaces).

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::{U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{serde_json, testing_env, AccountId, Gas, NearToken, PromiseResult, PublicKey};

use crate::attestation::{near_ai_binding_marker, receipt_digest, EnclaveKind, ExecutionProof, ExecutionReceipt, NearAiProof, SignedReceipt};
use crate::codec::to_hex;
use crate::evm::{EvmTransferRequest, EvmTxStatus};
use crate::intents::{build_intent_message, nep413_hash, CrossChainIntentRequest, IntentKind, IntentStatus, QuoteBinding};
use crate::policy::{AgentPolicy, EvmChainPolicy, EvmTokenPolicy, GlobalPolicy, PolicyViolation, Severity};
use crate::subaccounts::{AgentRole, AgentStatus, SpawnMode};
use crate::swarm_market::{bid_commitment, AuctionKind, BidAction, TaskRfpInput, TaskStatus, VerificationSchema};
use crate::*;

const T0: u64 = 1_793_491_200_000_000_000; // 2026-11-01T00:00:00Z
const SEC: u64 = 1_000_000_000;
const USDC_ARB: &str = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const USDC_ETH: &str = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const WNEAR: &str = "nep141:wrap.near";
const VENDOR_EVM: &str = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const ATTACKER_EVM: &str = "0x000000000000000000000000000000000000BEEF";
const ENCLAVE_ID: &str = "nearai-tdx-h100-sim-01";
const NEARAI_ENCLAVE: &str = "nearai-model-test-01";
const NEARAI_MODEL: &str = "Qwen/Qwen3.6-35B-A3B-FP8";
const BASE_SEPOLIA_USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract() -> AccountId {
    acc("aegis-swarm.testnet")
}
fn owner() -> AccountId {
    acc("aegis.sputnikv2.testnet")
}
fn mpc() -> AccountId {
    acc("v1.signer-prod.testnet")
}
fn vendor() -> AccountId {
    acc("vendor-a.testnet")
}
fn near(n: u128) -> u128 {
    n * ONE_NEAR
}
fn sha_hex(data: &str) -> String {
    to_hex(&near_sdk::env::sha256_array(data.as_bytes()))
}
fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn near_pk(sk: &SigningKey) -> PublicKey {
    format!("ed25519:{}", near_sdk::bs58::encode(sk.verifying_key().to_bytes()).into_string()).parse().unwrap()
}
fn sign(sk: &SigningKey, msg: &[u8]) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(sk.sign(msg).to_bytes()).into_string())
}
fn measurement() -> String {
    sha_hex("aegis-enclave-image:v1")
}
fn schema_hash() -> String {
    sha_hex("aegis.procurement.v1")
}

fn test_policy() -> GlobalPolicy {
    let mut p = GlobalPolicy::default_with(&acc("intents.near"), Some(&mpc()));
    p.allowed_recipients = vec![
        format!("arb:{}", VENDOR_EVM.to_lowercase()),
        format!("base:{}", VENDOR_EVM.to_lowercase()),
        format!("basesepolia:{}", VENDOR_EVM.to_lowercase()),
        format!("near:{}", vendor()),
    ];
    p.evm_chains = vec![EvmChainPolicy {
        chain: "basesepolia".into(),
        chain_id: 84_532,
        max_value_wei: U128(10_000_000_000_000_000),
        epoch_cap_wei: U128(50_000_000_000_000_000),
        max_fee_wei: U128(1_000_000_000_000_000),
        tokens: vec![EvmTokenPolicy {
            token: BASE_SEPOLIA_USDC.into(),
            symbol: "USDC".into(),
            max_amount: U128(5_000_000),
            epoch_cap: U128(20_000_000),
        }],
    }];
    p
}

#[allow(clippy::too_many_arguments)]
fn set_ctx_with_balance(
    predecessor: &AccountId,
    signer: &AccountId,
    pk: Option<&PublicKey>,
    deposit: u128,
    now: u64,
    epoch: u64,
    results: Vec<PromiseResult>,
    balance: u128,
) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(signer.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .block_height(1_000 + (now - T0) / SEC)
        .epoch_height(epoch)
        .account_balance(NearToken::from_yoctonear(balance))
        .prepaid_gas(Gas::from_tgas(300));
    if let Some(pk) = pk {
        b.signer_account_pk(pk.clone());
    }
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
}

fn set_ctx(
    predecessor: &AccountId,
    signer: &AccountId,
    pk: Option<&PublicKey>,
    deposit: u128,
    now: u64,
    epoch: u64,
    results: Vec<PromiseResult>,
) {
    set_ctx_with_balance(predecessor, signer, pk, deposit, now, epoch, results, near(1_000));
}

#[derive(Clone)]
struct TestAgent {
    id: AccountId,
    sk: SigningKey,
    pk: PublicKey,
    mode: SpawnMode,
}

struct H {
    c: AegisCore,
    now: u64,
    epoch: u64,
    enclave: SigningKey,
    nearai: SigningKey,
}

impl H {
    fn new() -> Self {
        Self::with_owner(owner())
    }

    fn with_owner(owner_id: AccountId) -> Self {
        set_ctx(&contract(), &contract(), None, 0, T0, 10, vec![]);
        let config = ProtocolConfig { mpc_contract_id: Some(mpc()), ..ProtocolConfig::default_config() };
        let splits = vec![
            RevenueSplit {
                account_id: owner_id.clone(),
                bps: 5_000,
                label: "dao_treasury".into(),
                kind: StakeholderKind::DaoTreasury,
            },
            RevenueSplit {
                account_id: acc("ops-guild.testnet"),
                bps: 2_000,
                label: "operators".into(),
                kind: StakeholderKind::Operator,
            },
            RevenueSplit { account_id: contract(), bps: 3_000, label: "reserve".into(), kind: StakeholderKind::Reserve },
        ];
        let c = AegisCore::new(owner_id, Some(config), Some(test_policy()), Some(splits));
        H { c, now: T0, epoch: 10, enclave: key(200), nearai: key(210) }
    }

    fn owner_ctx(&self, deposit: u128) {
        let o = self.c.owner_id.clone();
        set_ctx(&o, &o, None, deposit, self.now, self.epoch, vec![]);
    }
    fn account_ctx(&self, id: &AccountId, deposit: u128) {
        set_ctx(id, id, None, deposit, self.now, self.epoch, vec![]);
    }
    fn agent_ctx(&self, a: &TestAgent) {
        match a.mode {
            SpawnMode::SubAccount => set_ctx(&a.id, &a.id, Some(&a.pk), 0, self.now, self.epoch, vec![]),
            SpawnMode::ContractKey => set_ctx(&contract(), &contract(), Some(&a.pk), 0, self.now, self.epoch, vec![]),
        }
    }
    fn callback_ctx(&self, results: Vec<PromiseResult>) {
        set_ctx(&contract(), &contract(), None, 0, self.now, self.epoch, results);
    }
    fn advance(&mut self, secs: u64) {
        self.now += secs * SEC;
    }

    fn fund(&mut self, capital: u128, revenue: u128) {
        if capital > 0 {
            self.account_ctx(&acc("investor.testnet"), near(capital));
            self.c.fund_treasury(Some("seed capital".into()));
        }
        if revenue > 0 {
            self.account_ctx(&acc("acme-corp.testnet"), near(revenue));
            self.c.deposit_revenue("acme-corp".into(), Some("invoice 2026-11".into()));
        }
    }

    fn spawn_with(&mut self, handle: &str, role: AgentRole, mode: SpawnMode, seed: u8, reputation: Option<u32>) -> TestAgent {
        let sk = key(seed);
        let pk = near_pk(&sk);
        let deposit = if mode == SpawnMode::SubAccount { near(1) / 2 } else { 0 };
        self.owner_ctx(deposit);
        let payout = Some(acc("ops-guild.testnet"));
        let rec = self.c.register_and_spawn_agent(handle.into(), role, pk.clone(), U128(near(1) / 4), Some(mode), payout, None, reputation);
        assert_eq!(rec.status, AgentStatus::Provisioning);
        self.callback_ctx(vec![PromiseResult::Successful(vec![])]);
        assert!(self.c.on_agent_spawned(rec.agent_id.clone(), U128(deposit)));
        TestAgent { id: rec.agent_id, sk, pk, mode }
    }

    fn spawn(&mut self, handle: &str, role: AgentRole, mode: SpawnMode, seed: u8) -> TestAgent {
        self.spawn_with(handle, role, mode, seed, None)
    }

    fn register_enclave(&mut self) {
        self.owner_ctx(0);
        self.c.register_enclave(
            ENCLAVE_ID.into(),
            measurement(),
            near_pk(&self.enclave),
            "Self-hosted CVM (test)".into(),
            "aegis/policy-auditor-v1".into(),
            "intel-tdx".into(),
            None,
            None,
        );
    }

    fn register_nearai_model(&mut self) {
        self.owner_ctx(0);
        let record = self.c.register_enclave(
            NEARAI_ENCLAVE.into(),
            "7f".repeat(48),
            near_pk(&self.nearai),
            "NEAR AI Cloud (test key)".into(),
            NEARAI_MODEL.into(),
            "intel-tdx+nvidia-cc".into(),
            Some(EnclaveKind::NearAiModel),
            Some("sha256:test-attestation".into()),
        );
        assert_eq!(record.kind, EnclaveKind::NearAiModel);
    }

    #[allow(clippy::too_many_arguments)]
    fn receipt(
        &self,
        kind: &str,
        subject_id: u64,
        agent: &AccountId,
        input_hash: &str,
        schema: &str,
        verdict: &str,
        nonce: &str,
        signer: &SigningKey,
    ) -> ExecutionProof {
        let receipt = ExecutionReceipt {
            subject_kind: kind.into(),
            subject_id: U64(subject_id),
            agent_id: agent.clone(),
            enclave_id: ENCLAVE_ID.into(),
            measurement: measurement(),
            model_id: "aegis/policy-auditor-v1".into(),
            input_hash: input_hash.into(),
            output_hash: sha_hex(&format!("output:{nonce}")),
            schema_hash: schema.into(),
            verdict: verdict.into(),
            confidence_bps: 9_400,
            issued_at_ns: U64(self.now),
            nonce: nonce.into(),
        };
        let signature = sign(signer, &receipt_digest(&receipt));
        ExecutionProof::Receipt(SignedReceipt { receipt, signature })
    }

    /// A NEAR AI-format proof: exact request/response bodies, `req:resp` text, ed25519 signature.
    #[allow(clippy::too_many_arguments)]
    fn nearai_proof(
        &self,
        kind: &str,
        subject_id: u64,
        agent: &AccountId,
        input_hash: &str,
        schema: &str,
        verdict: &str,
        confidence: u32,
        nonce: &str,
    ) -> NearAiProof {
        let marker = near_ai_binding_marker(kind, subject_id, agent.as_str(), input_hash, nonce, self.now);
        let request_body = serde_json::json!({
            "model": NEARAI_MODEL,
            "messages": [
                { "role": "system", "content": format!("You verify work for AegisSwarm. {marker}") },
                { "role": "user", "content": "Return the verdict as JSON." }
            ],
            "response_format": { "type": "json_object" }
        })
        .to_string();
        let content = serde_json::json!({ "verdict": verdict, "confidence_bps": confidence, "notes": "ok" }).to_string();
        let chat_id = format!("chatcmpl-{nonce}");
        let response_body = serde_json::json!({
            "id": chat_id,
            "object": "chat.completion",
            "model": NEARAI_MODEL,
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": content }, "finish_reason": "stop" }]
        })
        .to_string();
        let signed_text = format!("{}:{}", sha_hex(&request_body), sha_hex(&response_body));
        let signature = to_hex(&self.nearai.sign(signed_text.as_bytes()).to_bytes());
        NearAiProof {
            enclave_id: NEARAI_ENCLAVE.into(),
            chat_id,
            subject_kind: kind.into(),
            subject_id: U64(subject_id),
            agent_id: agent.clone(),
            input_hash: input_hash.into(),
            schema_hash: schema.into(),
            nonce: nonce.into(),
            issued_at_ns: U64(self.now),
            request_body,
            response_body,
            signed_text,
            signature,
        }
    }

    fn rfp(&self, auction: AuctionKind, budget: u128) -> TaskRfpInput {
        TaskRfpInput {
            title: "Q4 GPU inference procurement".into(),
            category: "procurement".into(),
            spec_hash: sha_hex("spec:q4-procurement"),
            budget_ceiling: U128(budget),
            auction,
            dutch_start_price: if auction == AuctionKind::ReverseDutch { Some(U128(budget / 3)) } else { None },
            bidding_window_sec: 600,
            reveal_window_sec: if auction == AuctionKind::SealedBid { Some(600) } else { None },
            execution_window_sec: 3_600,
            deadline_epochs: 2,
            max_bidders: 3,
            verification: VerificationSchema {
                schema_id: "aegis.procurement.v1".into(),
                schema_hash: schema_hash(),
                min_confidence_bps: 8_000,
                min_reputation_bps: 4_000,
            },
        }
    }

    /// A signed swap request (optionally with a sentinel TEE audit receipt).
    #[allow(clippy::too_many_arguments)]
    fn intent(
        &self,
        agent: &TestAgent,
        amount: u128,
        chain: &str,
        dest_asset: &str,
        exec: &str,
        nonce_seed: u8,
        attest: bool,
    ) -> CrossChainIntentRequest {
        let amount_out = amount / ONE_NEAR * 4_713_776 + 1;
        let min_out = amount_out * 9_950 / 10_000;
        let mut req = CrossChainIntentRequest {
            kind: IntentKind::Swap,
            destination_chain: chain.into(),
            origin_asset: WNEAR.into(),
            destination_asset: dest_asset.into(),
            amount: U128(amount),
            min_amount_out: U128(min_out),
            recipient: VENDOR_EVM.into(),
            execution_contract: acc(exec),
            slippage_bps: 50,
            deadline_ns: U64(self.now + 900 * SEC),
            quote: Some(QuoteBinding {
                provider: "1click".into(),
                quote_hash: sha_hex(&format!("quote:{nonce_seed}")),
                correlation_id: "1bdc6d5e-e2ba-4497-a480-78311dc55e25".into(),
                amount_in: U128(amount),
                amount_out: U128(amount_out),
                min_amount_out: U128(min_out),
                expires_at_ns: U64(self.now + 600 * SEC),
                dry: true,
                deposit_address: None,
            }),
            nonce: String::new(),
            signature: String::new(),
            attestation: None,
            memo: Some("q4 treasury rebalance".into()),
        };
        self.sign_intent(agent, &mut req, nonce_seed, attest);
        req
    }

    /// A NEAR vendor invoice paid as a real transfer.
    fn near_payment(&self, agent: &TestAgent, amount: u128, recipient: &str, nonce_seed: u8, attest: bool) -> CrossChainIntentRequest {
        let mut req = CrossChainIntentRequest {
            kind: IntentKind::VendorPayment,
            destination_chain: "near".into(),
            origin_asset: WNEAR.into(),
            destination_asset: WNEAR.into(),
            amount: U128(amount),
            min_amount_out: U128(amount),
            recipient: recipient.into(),
            execution_contract: acc("intents.near"),
            slippage_bps: 0,
            deadline_ns: U64(self.now + 900 * SEC),
            quote: None,
            nonce: String::new(),
            signature: String::new(),
            attestation: None,
            memo: Some("vendor invoice".into()),
        };
        self.sign_intent(agent, &mut req, nonce_seed, attest);
        req
    }

    fn sign_intent(&self, agent: &TestAgent, req: &mut CrossChainIntentRequest, nonce_seed: u8, attest: bool) {
        let nonce = [nonce_seed; 32];
        req.nonce = near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, nonce);
        let message = build_intent_message(agent.id.as_str(), req);
        let hash = nep413_hash(&message, &nonce, contract().as_str());
        req.signature = sign(&agent.sk, &hash);
        if attest {
            let audit_schema = sha_hex("aegis.intent-audit.v1");
            req.attestation = Some(self.receipt(
                "intent",
                0,
                &agent.id,
                &to_hex(&hash),
                &audit_schema,
                "approve",
                &format!("audit-{nonce_seed}"),
                &self.enclave,
            ));
        }
    }

    fn evm_request(&self, to: &str, asset: &str, amount: u128) -> EvmTransferRequest {
        EvmTransferRequest {
            chain: "basesepolia".into(),
            to: to.into(),
            asset: asset.into(),
            amount: U128(amount),
            nonce: U64(0),
            gas_limit: U64(if asset == "native" { 21_000 } else { 65_000 }),
            max_fee_per_gas: U128(2_000_000_000),
            max_priority_fee_per_gas: U128(1_000_000_000),
            memo: Some("vendor payout".into()),
            attestation: None,
        }
    }

    /// An EVM request with a sentinel receipt bound to the contract's signing hash.
    fn attested_evm_request(&self, agent: &TestAgent, to: &str, asset: &str, amount: u128, nonce: &str) -> EvmTransferRequest {
        let mut req = self.evm_request(to, asset, amount);
        let preview = self.c.preview_evm_transfer(req.clone());
        req.attestation = Some(self.receipt(
            "evm",
            0,
            &agent.id,
            &preview.signing_hash,
            &sha_hex("aegis.evm-audit.v1"),
            "approve",
            nonce,
            &self.enclave,
        ));
        req
    }
}

fn worker_scope() -> Vec<String> {
    ["submit_bid", "execute_verified_task", "request_intent_settlement", "request_evm_transfer", "pay_from_balance", "withdraw_earnings"]
        .iter()
        .map(|m| m.to_string())
        .collect()
}

fn mpc_response() -> Vec<u8> {
    format!(r#"{{"scheme":"Secp256k1","big_r":{{"affine_point":"02{}"}},"s":{{"scalar":"{}"}},"recovery_id":1}}"#, "ab".repeat(32), "cd".repeat(32))
        .into_bytes()
}

// Vault

#[test]
fn init_sets_owner_policy_splits_and_empty_treasury() {
    let h = H::new();
    assert_eq!(h.c.get_owner(), owner());
    let policy = h.c.get_global_policy();
    assert!(policy.require_tee_attestation);
    assert!(policy.allowed_contract_ids.contains(&acc("intents.near")));
    assert!(policy.allowed_contract_ids.contains(&mpc()));
    assert_eq!(h.c.get_revenue_splits().iter().map(|s| s.bps).sum::<u32>(), 10_000);
    let t = h.c.get_treasury();
    assert_eq!(t.liquid.0, 0);
    assert_eq!(t.total_revenue.0, 0);
    assert!(!h.c.is_paused());
    assert_eq!(h.c.contract_info().nep413_recipient, contract());
    assert_eq!(h.c.contract_info().version, "2.0.0");
    let default = GlobalPolicy::default_with(&acc("intents.near"), None);
    assert!(default.allowed_recipients.is_empty(), "nothing may leave the treasury until the DAO names destinations");
}

#[test]
fn funding_and_revenue_update_ledger_and_pnl() {
    let mut h = H::new();
    h.fund(100, 40);
    let t = h.c.get_treasury();
    assert_eq!(t.liquid.0, near(140));
    assert_eq!(t.total_capital_in.0, near(100));
    assert_eq!(t.total_revenue.0, near(40));
    assert_eq!(t.available.0, near(138), "2 NEAR operating reserve is excluded");
    assert_eq!(t.net_profit.0, near(40));
    assert_eq!(t.distributable_profit.0, near(40));
    assert_eq!(t.unbacked_liquidity.0, 0);
    assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"treasury_funded\"")));
}

#[test]
fn available_liquidity_is_capped_by_the_real_account_balance() {
    let mut h = H::new();
    h.fund(100, 40);
    // Gas burned by contract keys, failed refunds etc. leave the balance below the ledger.
    set_ctx_with_balance(&owner(), &owner(), None, 0, h.now, h.epoch, vec![], near(60));
    let t = h.c.get_treasury();
    assert_eq!(t.liquid.0, near(140));
    assert!(t.solvent_liquidity.0 < near(60));
    assert_eq!(t.available.0, t.solvent_liquidity.0 - near(2));
    assert_eq!(t.unbacked_liquidity.0, near(140) - t.solvent_liquidity.0);
}

// Agents and keys

#[test]
fn spawn_subaccount_agent_provisions_scoped_function_call_key_only() {
    let mut h = H::new();
    let sk = key(1);
    h.owner_ctx(near(1) / 2);
    let rec = h.c.register_and_spawn_agent(
        "cipher-compute-worker".into(),
        AgentRole::ComputeWorker,
        near_pk(&sk),
        U128(near(1) / 4),
        None,
        None,
        None,
        None,
    );
    assert_eq!(rec.agent_id, acc("cipher-compute-worker.aegis-swarm.testnet"));
    assert_eq!(rec.allowed_methods, worker_scope());
    assert_eq!(rec.reputation_bps, 5_000);
    assert_eq!(rec.balance.0, 0);

    let receipts = get_created_receipts();
    let spawn = receipts.iter().find(|r| r.receiver_id == rec.agent_id).expect("provisioning receipt");
    assert!(spawn.actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })));
    assert!(spawn
        .actions
        .iter()
        .any(|a| matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == near(1) / 2)));
    let fc_key = spawn
        .actions
        .iter()
        .find_map(|a| match a {
            MockAction::AddKeyWithFunctionCall { public_key, allowance, receiver_id, method_names, .. } => {
                Some((public_key.to_string(), *allowance, receiver_id.clone(), method_names.clone()))
            }
            _ => None,
        })
        .expect("function-call key");
    assert_eq!(fc_key.0, String::from(&near_pk(&sk)));
    assert_eq!(fc_key.1, Some(NearToken::from_yoctonear(near(1) / 4)));
    assert_eq!(fc_key.2, contract());
    assert_eq!(fc_key.3, worker_scope());
    assert!(
        !receipts.iter().flat_map(|r| r.actions.iter()).any(|a| matches!(a, MockAction::AddKeyWithFullAccess { .. })),
        "no FullAccess key is ever created"
    );

    h.callback_ctx(vec![PromiseResult::Successful(vec![])]);
    assert!(h.c.on_agent_spawned(rec.agent_id.clone(), U128(near(1) / 2)));
    let agent = h.c.get_agent(rec.agent_id).unwrap();
    assert_eq!(agent.status, AgentStatus::Active);
    assert!(agent.key_active);
}

#[test]
fn contract_key_mode_scopes_methods_and_books_gas_allowance() {
    let mut h = H::new();
    h.fund(100, 0);
    h.owner_ctx(0);
    let rec = h.c.register_and_spawn_agent(
        "nexus-orchestrator".into(),
        AgentRole::Orchestrator,
        near_pk(&key(2)),
        U128(near(1) / 4),
        Some(SpawnMode::ContractKey),
        None,
        None,
        None,
    );
    let receipts = get_created_receipts();
    let on_self = receipts.iter().find(|r| r.receiver_id == contract()).expect("key receipt on the contract account");
    let methods = on_self
        .actions
        .iter()
        .find_map(|a| match a {
            MockAction::AddKeyWithFunctionCall { receiver_id, method_names, .. } if *receiver_id == contract() => {
                Some(method_names.clone())
            }
            _ => None,
        })
        .unwrap();
    let mut expected = worker_scope();
    expected.extend(["post_task_rfp".to_string(), "close_auction".to_string()]);
    assert_eq!(methods, expected);
    assert_eq!(rec.allowed_methods, methods);
    assert_eq!(h.c.get_role_scope(AgentRole::Sentinel).len(), 10);
    let t = h.c.get_treasury();
    assert_eq!(t.contract_key_allowances.0, near(1) / 4, "the key's gas allowance is an obligation");

    h.callback_ctx(vec![PromiseResult::Successful(vec![])]);
    h.c.on_agent_spawned(rec.agent_id.clone(), U128(0));
    h.owner_ctx(0);
    h.c.freeze_agent(rec.agent_id, "review".into());
    assert_eq!(h.c.get_treasury().contract_key_allowances.0, 0, "deleting the key ends the obligation");
}

#[test]
#[should_panic(expected = "AEGIS_E_OWNER_ONLY")]
fn non_owner_cannot_spawn_agent() {
    let mut h = H::new();
    h.account_ctx(&acc("mallory.testnet"), near(1));
    h.c.register_and_spawn_agent("evil".into(), AgentRole::ComputeWorker, near_pk(&key(9)), U128(near(1) / 4), None, None, None, None);
}

#[test]
fn failed_spawn_rolls_back_and_refunds_owner() {
    let mut h = H::new();
    h.owner_ctx(near(1) / 2);
    let rec = h.c.register_and_spawn_agent(
        "ghost-worker".into(),
        AgentRole::ComputeWorker,
        near_pk(&key(3)),
        U128(near(1) / 4),
        None,
        None,
        None,
        None,
    );
    h.callback_ctx(vec![PromiseResult::Failed]);
    assert!(!h.c.on_agent_spawned(rec.agent_id.clone(), U128(near(1) / 2)));
    assert!(h.c.get_agent(rec.agent_id).is_none());
    let refund = get_created_receipts().into_iter().find(|r| r.receiver_id == owner()).expect("refund to owner");
    assert!(refund
        .actions
        .iter()
        .any(|a| matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == near(1) / 2)));
}

#[test]
#[should_panic(expected = "AEGIS_E_OWNER_ONLY")]
fn agent_key_on_self_owned_contract_cannot_act_as_owner() {
    // The contract owns itself; an agent signing with its contract-account key must not pass owner checks.
    let mut h = H::with_owner(contract());
    h.fund(10, 0);
    let rogue = h.spawn("mallory-rogue-worker", AgentRole::ComputeWorker, SpawnMode::ContractKey, 66);
    let policy = h.c.get_global_policy();
    h.agent_ctx(&rogue);
    h.c.update_global_policy(policy);
}

// Market

#[test]
fn sealed_bid_auction_scores_binding_terms_and_reputation() {
    let mut h = H::new();
    h.fund(100, 40);
    let nexus = h.spawn("nexus-orchestrator", AgentRole::Orchestrator, SpawnMode::SubAccount, 1);
    let cipher = h.spawn("cipher-compute-worker", AgentRole::ComputeWorker, SpawnMode::SubAccount, 2);
    let atlas = h.spawn("atlas-compute-worker", AgentRole::ComputeWorker, SpawnMode::SubAccount, 3);

    h.agent_ctx(&nexus);
    let posted = h.c.post_task_rfp(h.rfp(AuctionKind::SealedBid, near(8)));
    assert!(posted.approved);
    let task_id = posted.task.unwrap().task_id;
    assert_eq!(h.c.get_treasury().reserved_for_tasks.0, near(8));

    let bids = [(&cipher, near(6), 900u32, "salt-cipher-001"), (&atlas, near(7), 600, "salt-atlas-0001")];
    for (agent, price, lat, salt) in bids {
        h.agent_ctx(agent);
        let commitment = bid_commitment(task_id.0, agent.id.as_str(), price, lat, salt);
        h.c.submit_bid(task_id, BidAction::Commit { commitment });
    }
    h.advance(601);
    for (agent, price, lat, salt) in bids {
        h.agent_ctx(agent);
        let bid = h.c.submit_bid(task_id, BidAction::Reveal { price: U128(price), est_latency_sec: lat, salt: salt.into() });
        assert!(bid.revealed && bid.score_bps.is_some());
        assert_eq!(bid.reputation_bps, Some(5_000));
    }
    h.agent_ctx(&nexus);
    let task = h.c.close_auction(task_id);
    assert_eq!(task.status, TaskStatus::Awarded);
    assert_eq!(task.winner, Some(cipher.id.clone()));
    assert_eq!(task.winning_price, Some(U128(near(6))));
    assert_eq!(task.winning_latency_sec, Some(900));
    assert_eq!(task.execution_deadline_ns.0, h.now + 900 * SEC, "the promised latency is the deadline");
    let view = h.c.get_task(task_id).unwrap();
    assert_eq!(view.escrow.unwrap().amount.0, near(6));
    let t = h.c.get_treasury();
    assert_eq!(t.escrow_locked.0, near(6));
    assert_eq!(t.reserved_for_tasks.0, 0);
    assert_eq!(t.liquid.0, near(140 - 6));
}

#[test]
#[should_panic(expected = "AEGIS_E_REPUTATION_BELOW_SCHEMA")]
fn unvetted_agent_cannot_bid_below_the_reputation_floor() {
    let mut h = H::new();
    h.fund(100, 0);
    let nexus = h.spawn("nexus-orchestrator", AgentRole::Orchestrator, SpawnMode::SubAccount, 1);
    let mallory = h.spawn_with("mallory-rogue-worker", AgentRole::ComputeWorker, SpawnMode::ContractKey, 66, Some(2_000));
    h.agent_ctx(&nexus);
    let task_id = h.c.post_task_rfp(h.rfp(AuctionKind::SealedBid, near(8))).task.unwrap().task_id;
    h.agent_ctx(&mallory);
    let commitment = bid_commitment(task_id.0, mallory.id.as_str(), near(1), 30, "salt-mallory-01");
    h.c.submit_bid(task_id, BidAction::Commit { commitment });
}

#[test]
#[should_panic(expected = "AEGIS_E_COMMITMENT_MISMATCH")]
fn reveal_with_wrong_salt_is_rejected() {
    let mut h = H::new();
    h.fund(100, 0);
    let nexus = h.spawn("nexus-orchestrator", AgentRole::Orchestrator, SpawnMode::SubAccount, 1);
    let cipher = h.spawn("cipher-compute-worker", AgentRole::ComputeWorker, SpawnMode::SubAccount, 2);
    h.agent_ctx(&nexus);
    let task_id = h.c.post_task_rfp(h.rfp(AuctionKind::SealedBid, near(8))).task.unwrap().task_id;
    h.agent_ctx(&cipher);
    let commitment = bid_commitment(task_id.0, cipher.id.as_str(), near(6), 900, "right-salt-01");
    h.c.submit_bid(task_id, BidAction::Commit { commitment });
    h.advance(601);
    h.agent_ctx(&cipher);
    h.c.submit_bid(task_id, BidAction::Reveal { price: U128(near(6)), est_latency_sec: 900, salt: "wrong-salt-01".into() });
}

#[test]
fn reverse_dutch_price_rises_and_first_accept_wins() {
    let mut h = H::new();
    h.fund(100, 0);
    let nexus = h.spawn("nexus-orchestrator", AgentRole::Orchestrator, SpawnMode::SubAccount, 1);
    let rhea = h.spawn("rhea-yield-strategist", AgentRole::YieldStrategist, SpawnMode::SubAccount, 4);
    h.agent_ctx(&nexus);
    let task_id = h.c.post_task_rfp(h.rfp(AuctionKind::ReverseDutch, near(3))).task.unwrap().task_id;
    assert_eq!(h.c.get_dutch_price(task_id).0, near(1));
    h.advance(150);
    h.agent_ctx(&rhea);
    let expected = near(1) + near(2) * 150 / 600;
    assert_eq!(h.c.get_dutch_price(task_id).0, expected);
    let bid = h.c.submit_bid(task_id, BidAction::AcceptDutch { est_latency_sec: 120 });
    assert_eq!(bid.price, Some(U128(expected)));
    let task = h.c.get_task(task_id).unwrap().task;
    assert_eq!(task.status, TaskStatus::Awarded);
    assert_eq!(task.winner, Some(rhea.id));
    assert_eq!(task.execution_deadline_ns.0, h.now + 120 * SEC);
    assert_eq!(h.c.get_treasury().escrow_locked.0, expected);
}

fn awarded_task(h: &mut H) -> (TestAgent, TestAgent, U64) {
    h.fund(100, 40);
    h.register_enclave();
    h.register_nearai_model();
    let nexus = h.spawn("nexus-orchestrator", AgentRole::Orchestrator, SpawnMode::SubAccount, 1);
    let cipher = h.spawn("cipher-compute-worker", AgentRole::ComputeWorker, SpawnMode::SubAccount, 2);
    h.agent_ctx(&nexus);
    let task_id = h.c.post_task_rfp(h.rfp(AuctionKind::SealedBid, near(8))).task.unwrap().task_id;
    h.agent_ctx(&cipher);
    h.c.submit_bid(task_id, BidAction::Commit { commitment: bid_commitment(task_id.0, cipher.id.as_str(), near(6), 900, "salt-cipher-001") });
    h.advance(601);
    h.agent_ctx(&cipher);
    h.c.submit_bid(task_id, BidAction::Reveal { price: U128(near(6)), est_latency_sec: 900, salt: "salt-cipher-001".into() });
    h.agent_ctx(&nexus);
    h.c.close_auction(task_id);
    (nexus, cipher, task_id)
}

#[test]
fn enclave_receipt_releases_escrow_to_the_winners_balance() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    h.advance(120);
    let spec = h.c.get_task(task_id).unwrap().task.spec_hash;
    let proof = h.receipt("task", task_id.0, &cipher.id, &spec, &schema_hash(), "completed", "exec-001", &h.enclave.clone());
    h.agent_ctx(&cipher);
    let check = h.c.verify_attestation(proof.clone());
    assert!(check.valid, "{:?}", check.reason);
    let out = h.c.execute_verified_task(task_id, proof);
    assert!(out.settled, "{:?}", out.error);
    assert_eq!(out.payout.0, near(6));
    assert!(get_created_receipts().iter().all(|r| r.receiver_id != cipher.id), "earnings stay spendable on-chain");

    let task = h.c.get_task(task_id).unwrap();
    assert_eq!(task.task.status, TaskStatus::Completed);
    let record = h.c.get_attestation(out.receipt_hash.unwrap()).unwrap();
    assert_eq!(record.receipt.agent_id, cipher.id);
    assert_eq!(record.proof_kind, "receipt");
    let worker = h.c.get_agent(cipher.id.clone()).unwrap();
    assert_eq!(worker.tasks_completed, 1);
    assert_eq!(worker.reputation_bps, 5_250);
    assert_eq!(worker.balance.0, near(6));
    assert_eq!(worker.total_earned.0, near(6));
    let t = h.c.get_treasury();
    assert_eq!(t.escrow_locked.0, 0);
    assert_eq!(t.agent_balances.0, near(6));
    assert_eq!(t.total_operating_costs.0, near(6));
    assert_eq!(t.net_profit.0, near(34));
}

#[test]
fn near_ai_signed_completion_releases_escrow() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    h.advance(60);
    let spec = h.c.get_task(task_id).unwrap().task.spec_hash;
    let proof = h.nearai_proof("task", task_id.0, &cipher.id, &spec, &schema_hash(), "completed", 9_400, "exec-nearai-001");
    h.agent_ctx(&cipher);
    let out = h.c.execute_verified_task(task_id, ExecutionProof::NearAi(proof.clone()));
    assert!(out.settled, "{:?}", out.error);
    let hash = out.receipt_hash.unwrap();
    assert_eq!(hash, sha_hex(&proof.signed_text));
    let record = h.c.get_attestation(hash).unwrap();
    assert_eq!(record.proof_kind, "near_ai");
    assert_eq!(record.receipt.model_id, NEARAI_MODEL);
    assert_eq!(record.receipt.output_hash, sha_hex(&proof.response_body));
    assert_eq!(record.receipt.confidence_bps, 9_400);
    assert_eq!(h.c.list_enclaves().iter().find(|e| e.enclave_id == NEARAI_ENCLAVE).unwrap().receipts_verified, 1);
}

#[test]
fn tampered_near_ai_response_is_a_forgery() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    let spec = h.c.get_task(task_id).unwrap().task.spec_hash;
    let mut proof = h.nearai_proof("task", task_id.0, &cipher.id, &spec, &schema_hash(), "completed", 9_400, "exec-nearai-002");
    proof.response_body = proof.response_body.replace("9400", "9999");
    h.agent_ctx(&cipher);
    let out = h.c.execute_verified_task(task_id, ExecutionProof::NearAi(proof));
    assert!(!out.settled);
    assert_eq!(out.error.as_deref(), Some("body_hash_mismatch"));
    assert!(out.quarantined);
}

#[test]
fn near_ai_proof_for_another_task_is_rejected() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    let spec = h.c.get_task(task_id).unwrap().task.spec_hash;
    // Correctly signed by the model, but bound to task 99: the marker does not match this claim.
    let mut proof = h.nearai_proof("task", 99, &cipher.id, &spec, &schema_hash(), "completed", 9_400, "exec-nearai-003");
    proof.subject_id = task_id;
    h.agent_ctx(&cipher);
    let out = h.c.execute_verified_task(task_id, ExecutionProof::NearAi(proof));
    assert_eq!(out.error.as_deref(), Some("binding_missing"));
    assert!(out.quarantined);
}

#[test]
fn low_confidence_near_ai_verdict_does_not_settle_and_is_not_a_forgery() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    let spec = h.c.get_task(task_id).unwrap().task.spec_hash;
    let proof = h.nearai_proof("task", task_id.0, &cipher.id, &spec, &schema_hash(), "completed", 6_000, "exec-nearai-004");
    h.agent_ctx(&cipher);
    let out = h.c.execute_verified_task(task_id, ExecutionProof::NearAi(proof));
    assert_eq!(out.error.as_deref(), Some("low_confidence"));
    assert!(!out.quarantined);
    assert_eq!(h.c.get_task(task_id).unwrap().task.status, TaskStatus::Awarded, "the worker may retry before its deadline");
}

#[test]
fn forged_attestation_is_rejected_and_quarantines_worker() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    let spec = h.c.get_task(task_id).unwrap().task.spec_hash;
    let forged = h.receipt("task", task_id.0, &cipher.id, &spec, &schema_hash(), "completed", "exec-001", &key(201));
    h.agent_ctx(&cipher);
    let out = h.c.execute_verified_task(task_id, forged);
    assert!(!out.settled);
    assert_eq!(out.error.as_deref(), Some("bad_signature"));
    assert!(out.quarantined);
    assert!(matches!(h.c.get_agent(cipher.id).unwrap().status, AgentStatus::Quarantined { .. }));
    let t = h.c.get_treasury();
    assert_eq!(t.escrow_locked.0, 0, "escrow refunded to the treasury");
    assert_eq!(h.c.get_task(task_id).unwrap().task.status, TaskStatus::Failed);
}

#[test]
fn missing_the_promised_latency_fails_the_task() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    h.advance(901);
    h.account_ctx(&acc("keeper.testnet"), 0);
    let task = h.c.expire_task(task_id);
    assert_eq!(task.status, TaskStatus::Failed);
    let worker = h.c.get_agent(cipher.id).unwrap();
    assert_eq!(worker.reputation_bps, 4_500);
    assert_eq!(h.c.get_treasury().escrow_locked.0, 0);
}

// Earnings

#[test]
fn agents_pay_each_other_and_withdraw_from_earnings() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    let rhea = h.spawn("rhea-yield-strategist", AgentRole::YieldStrategist, SpawnMode::SubAccount, 4);
    let spec = h.c.get_task(task_id).unwrap().task.spec_hash;
    let proof = h.receipt("task", task_id.0, &cipher.id, &spec, &schema_hash(), "completed", "exec-005", &h.enclave.clone());
    h.agent_ctx(&cipher);
    assert!(h.c.execute_verified_task(task_id, proof).settled);

    h.agent_ctx(&cipher);
    let paid = h.c.pay_from_balance(rhea.id.clone(), U128(near(1)), Some("route data".into()));
    assert!(paid.paid && paid.internal);
    assert_eq!(h.c.get_agent(rhea.id.clone()).unwrap().balance.0, near(1));
    assert_eq!(h.c.get_agent(cipher.id.clone()).unwrap().balance.0, near(5));
    assert_eq!(h.c.get_treasury().agent_balances.0, near(6), "internal payments move no NEAR");

    h.agent_ctx(&cipher);
    let vendor_paid = h.c.pay_from_balance(vendor(), U128(near(1)), None);
    assert!(vendor_paid.paid && !vendor_paid.internal);
    let transfer = get_created_receipts().into_iter().find(|r| r.receiver_id == vendor()).expect("NEAR transfer to the vendor");
    assert!(transfer.actions.iter().any(|a| matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == near(1))));
    assert_eq!(h.c.get_treasury().agent_balances.0, near(5));

    h.agent_ctx(&cipher);
    assert_eq!(h.c.withdraw_earnings(U128(near(2))).0, near(2));
    let w = get_created_receipts().into_iter().find(|r| r.receiver_id == acc("ops-guild.testnet")).expect("payout to operator");
    assert!(w.actions.iter().any(|a| matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == near(2))));
    // A bounced withdrawal is credited back.
    h.callback_ctx(vec![PromiseResult::Failed]);
    assert!(!h.c.on_agent_transfer(cipher.id.clone(), acc("ops-guild.testnet"), U128(near(2))));
    // 6 earned - 1 to Rhea - 1 to the vendor - 2 withdrawn + 2 bounced back = 4.
    assert_eq!(h.c.get_agent(cipher.id).unwrap().balance.0, near(4));
    // Cipher 4 + Rhea 1.
    assert_eq!(h.c.get_treasury().agent_balances.0, near(5));
}

#[test]
fn paying_an_unknown_account_from_earnings_quarantines_the_agent() {
    let mut h = H::new();
    let (_nexus, cipher, task_id) = awarded_task(&mut h);
    let spec = h.c.get_task(task_id).unwrap().task.spec_hash;
    let proof = h.receipt("task", task_id.0, &cipher.id, &spec, &schema_hash(), "completed", "exec-006", &h.enclave.clone());
    h.agent_ctx(&cipher);
    assert!(h.c.execute_verified_task(task_id, proof).settled);
    h.agent_ctx(&cipher);
    let out = h.c.pay_from_balance(acc("attacker.testnet"), U128(near(1)), None);
    assert!(!out.paid);
    assert!(out.violations.iter().any(|v| matches!(v, PolicyViolation::RecipientNotAllowed { .. })));
    assert!(out.quarantined);
    assert_eq!(h.c.get_agent(cipher.id).unwrap().balance.0, near(6), "nothing left the balance");
}

// Intents

fn intent_setup() -> (H, TestAgent, TestAgent) {
    let mut h = H::new();
    h.fund(100, 40);
    h.register_enclave();
    let rhea = h.spawn("rhea-yield-strategist", AgentRole::YieldStrategist, SpawnMode::SubAccount, 4);
    let sentinel = h.spawn("aegis-sentinel", AgentRole::Sentinel, SpawnMode::SubAccount, 5);
    (h, rhea, sentinel)
}

#[test]
fn intent_within_policy_is_committed_and_requests_mpc_signature() {
    let (mut h, rhea, _sentinel) = intent_setup();
    let req = h.intent(&rhea, near(12), "arb", USDC_ARB, "intents.near", 7, true);
    h.agent_ctx(&rhea);
    let assessment = h.c.evaluate_intent(rhea.id.clone(), req.clone());
    assert!(assessment.signature_valid && assessment.decision.approved, "{:?}", assessment.decision.violations);

    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(req);
    assert_eq!(out.status, IntentStatus::Signing, "{:?}", out.decision.violations);
    assert_eq!(out.nep413_hash, assessment.nep413_hash);
    let sign_call = get_created_receipts().into_iter().find(|r| r.receiver_id == mpc()).expect("MPC sign receipt");
    let (args, deposit) = sign_call
        .actions
        .iter()
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } if method_name == b"sign" => {
                Some((String::from_utf8(args.clone()).unwrap(), *attached_deposit))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(deposit, NearToken::from_yoctonear(1));
    let record = h.c.get_intent(out.intent_id).unwrap();
    assert!(record.dry_run);
    let mpc_auth = record.mpc.clone().unwrap();
    assert_eq!(
        args,
        format!(r#"{{"request":{{"path":"aegis-treasury/arb","payload_v2":{{"Ecdsa":"{}"}},"domain_id":0}}}}"#, mpc_auth.payload)
    );
    assert!(record.attestation_hash.is_some());
    let t = h.c.get_treasury();
    assert_eq!(t.reserved_for_intents.0, near(12));
    assert_eq!(t.liquid.0, near(128));
    assert_eq!(h.c.get_agent(rhea.id).unwrap().spend.spent_in_epoch.0, near(12));
}

#[test]
fn dry_run_settlement_releases_the_reservation() {
    let (mut h, rhea, sentinel) = intent_setup();
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(h.intent(&rhea, near(12), "arb", USDC_ARB, "intents.near", 7, true));
    h.callback_ctx(vec![PromiseResult::Successful(mpc_response())]);
    assert_eq!(h.c.on_mpc_signature(out.intent_id), IntentStatus::Signed);
    let sig = h.c.get_intent(out.intent_id).unwrap().mpc.unwrap().signature.unwrap();
    assert_eq!(sig.recovery_id, 1);
    assert_eq!(sig.big_r.len(), 66);

    h.agent_ctx(&sentinel);
    let settled = h.c.confirm_intent_settlement(out.intent_id, "1click-dry:1bdc6d5e".into());
    assert_eq!(settled.status, IntentStatus::Settled);
    let t = h.c.get_treasury();
    assert_eq!(t.reserved_for_intents.0, 0);
    assert_eq!(t.total_deployed_capital.0, 0, "a dry-run moved nothing, so nothing is booked as deployed");
    assert_eq!(t.liquid.0, near(140));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"intent_settled\"") && l.contains("\"dry_run\":true")));
}

#[test]
fn live_quotes_are_not_executable_by_the_treasury() {
    let (mut h, rhea, _) = intent_setup();
    let mut req = h.intent(&rhea, near(2), "arb", USDC_ARB, "intents.near", 31, false);
    if let Some(q) = req.quote.as_mut() {
        q.dry = false;
    }
    h.sign_intent(&rhea, &mut req, 31, true);
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(req);
    assert!(out.decision.violations.contains(&PolicyViolation::QuoteInvalid { reason: "live_quote_not_executable_by_treasury".into() }));
}

#[test]
fn near_vendor_payment_moves_real_near() {
    let (mut h, rhea, _) = intent_setup();
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(h.near_payment(&rhea, near(2), vendor().as_str(), 40, true));
    assert_eq!(out.status, IntentStatus::Paying, "{:?}", out.decision.violations);
    let transfer = get_created_receipts().into_iter().find(|r| r.receiver_id == vendor()).expect("transfer to vendor");
    assert!(transfer.actions.iter().any(|a| matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == near(2))));
    assert!(get_created_receipts().iter().all(|r| r.receiver_id != mpc()), "NEAR payments need no MPC signature");
    assert!(!h.c.get_intent(out.intent_id).unwrap().dry_run);

    h.callback_ctx(vec![PromiseResult::Successful(vec![])]);
    assert_eq!(h.c.on_vendor_payment(out.intent_id), IntentStatus::Settled);
    let t = h.c.get_treasury();
    assert_eq!(t.reserved_for_intents.0, 0);
    assert_eq!(t.total_operating_costs.0, near(2));
    assert_eq!(t.liquid.0, near(138));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"vendor_paid\"")));
}

#[test]
fn bounced_vendor_payment_is_refunded() {
    let (mut h, rhea, _) = intent_setup();
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(h.near_payment(&rhea, near(2), vendor().as_str(), 41, true));
    h.callback_ctx(vec![PromiseResult::Failed]);
    assert_eq!(h.c.on_vendor_payment(out.intent_id), IntentStatus::PaymentFailed);
    let t = h.c.get_treasury();
    assert_eq!(t.liquid.0, near(140));
    assert_eq!(t.total_operating_costs.0, 0);
}

#[test]
fn invoice_fraud_inside_every_limit_is_blocked_by_the_recipient_allow_list() {
    let (mut h, _rhea, _) = intent_setup();
    let ap = h.spawn_with("mallory-ap-agent", AgentRole::ComputeWorker, SpawnMode::ContractKey, 66, Some(2_000));
    // 4 NEAR is under the worker's 5 NEAR per-tx limit and 10 NEAR epoch cap, on an allowed chain,
    // through an allowed contract, with a valid quote and even a valid TEE audit receipt. Only the
    // destination is wrong: the "updated bank details" in a poisoned invoice.
    let mut req = h.intent(&ap, near(4), "arb", USDC_ARB, "intents.near", 50, false);
    req.kind = IntentKind::VendorPayment;
    req.recipient = ATTACKER_EVM.into();
    h.sign_intent(&ap, &mut req, 50, true);
    h.agent_ctx(&ap);
    let out = h.c.request_intent_settlement(req);
    assert_eq!(out.status, IntentStatus::Rejected);
    assert_eq!(
        out.decision.violations,
        vec![PolicyViolation::RecipientNotAllowed { chain: "arb".into(), recipient: ATTACKER_EVM.into() }]
    );
    assert_eq!(out.decision.severity, Severity::Critical);
    assert!(out.quarantined);
    let revoke = get_created_receipts().into_iter().find(|r| r.receiver_id == contract()).expect("key revocation");
    assert!(revoke
        .actions
        .iter()
        .any(|a| matches!(a, MockAction::DeleteKey { public_key, .. } if public_key.to_string() == String::from(&ap.pk))));
    assert_eq!(h.c.get_treasury().liquid.0, near(140), "nothing moved");
}

#[test]
fn price_floor_blocks_value_extraction() {
    let (mut h, rhea, _) = intent_setup();
    let mut req = h.intent(&rhea, near(10), "arb", USDC_ARB, "intents.near", 60, false);
    // Self-consistent quote with an absurd output: 10 NEAR for 0.000010 USDC.
    if let Some(q) = req.quote.as_mut() {
        q.amount_out = U128(10);
        q.min_amount_out = U128(10);
    }
    req.min_amount_out = U128(10);
    h.sign_intent(&rhea, &mut req, 60, true);
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(req);
    assert!(out.decision.violations.iter().any(|v| matches!(v, PolicyViolation::PriceBelowFloor { .. })));
    assert_eq!(out.decision.severity, Severity::Critical);
    assert!(out.quarantined);
}

#[test]
fn mpc_failure_releases_reserved_funds() {
    let (mut h, rhea, _) = intent_setup();
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(h.intent(&rhea, near(12), "arb", USDC_ARB, "intents.near", 7, true));
    h.callback_ctx(vec![PromiseResult::Failed]);
    assert_eq!(h.c.on_mpc_signature(out.intent_id), IntentStatus::AuthorizationFailed);
    let t = h.c.get_treasury();
    assert_eq!(t.reserved_for_intents.0, 0);
    assert_eq!(t.liquid.0, near(140));
}

#[test]
fn epoch_cap_overspend_is_a_strike_not_a_quarantine() {
    let (mut h, rhea, _) = intent_setup();
    h.owner_ctx(0);
    let policy = AgentPolicy {
        max_tx_amount_yocto: U128(near(15)),
        epoch_spending_cap_yocto: U128(near(20)),
        allowed_target_chains: vec!["arb".into(), "base".into()],
        allowed_contract_ids: vec![],
        require_tee_attestation: false,
    };
    h.c.set_agent_policy(rhea.id.clone(), policy);
    h.agent_ctx(&rhea);
    assert_eq!(
        h.c.request_intent_settlement(h.intent(&rhea, near(15), "arb", USDC_ARB, "intents.near", 1, true)).status,
        IntentStatus::Signing
    );
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(h.intent(&rhea, near(15), "arb", USDC_ARB, "intents.near", 2, true));
    assert_eq!(out.status, IntentStatus::Rejected);
    assert_eq!(out.decision.severity, Severity::Warning);
    assert!(out.decision.violations.iter().any(|v| matches!(v, PolicyViolation::AgentEpochCapExceeded { .. })));
    assert!(!out.quarantined);
    let agent = h.c.get_agent(rhea.id).unwrap();
    assert_eq!(agent.status, AgentStatus::Active);
    assert_eq!(agent.violations, 1);
}

#[test]
fn unauthorized_destination_trips_circuit_breaker_and_revokes_key() {
    let (mut h, _rhea, _) = intent_setup();
    let rogue = h.spawn("mallory-rogue-worker", AgentRole::ComputeWorker, SpawnMode::ContractKey, 66);
    h.agent_ctx(&rogue);
    let out = h.c.request_intent_settlement(h.intent(&rogue, near(400), "eth", USDC_ETH, "drainer.near", 9, false));
    assert_eq!(out.status, IntentStatus::Rejected);
    assert_eq!(out.decision.severity, Severity::Critical);
    assert!(out.quarantined);
    let codes: Vec<&str> = out.decision.violations.iter().map(|v| v.code()).collect();
    for expected in ["amount_exceeds_tx_limit", "chain_not_allowed", "contract_not_allowed", "recipient_not_allowed", "missing_tee_attestation"] {
        assert!(codes.contains(&expected), "missing {expected} in {codes:?}");
    }
    let revoke = get_created_receipts().into_iter().find(|r| r.receiver_id == contract()).expect("key revocation");
    assert!(revoke
        .actions
        .iter()
        .any(|a| matches!(a, MockAction::DeleteKey { public_key, .. } if public_key.to_string() == String::from(&rogue.pk))));
    let agent = h.c.get_agent(rogue.id.clone()).unwrap();
    assert!(matches!(agent.status, AgentStatus::Quarantined { .. }));
    assert!(!agent.key_active);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"agent_quarantined\"")));
    let events = h.c.get_security_events(Some(5));
    assert_eq!(events[0].kind, "quarantine");
    assert_eq!(h.c.get_treasury().liquid.0, near(140), "nothing moved");
}

#[test]
fn unauthorized_token_is_blocked_and_quarantines_agent() {
    let (mut h, rhea, _) = intent_setup();
    // Correctly signed and TEE-attested, on an allowed chain and route, but the output token
    // is not on the treasury's asset allow-list (e.g. a scam airdrop token).
    let req = h.intent(
        &rhea,
        near(2),
        "arb",
        "nep141:arb-0xdeadbeef00000000000000000000000000000000.omft.near",
        "intents.near",
        22,
        true,
    );
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(req);
    assert_eq!(out.status, IntentStatus::Rejected);
    assert!(out.decision.violations.iter().any(|v| matches!(v, PolicyViolation::AssetNotAllowed { asset } if asset.contains("deadbeef"))));
    assert_eq!(out.decision.severity, Severity::Critical);
    assert!(out.quarantined);
    assert!(matches!(h.c.get_agent(rhea.id).unwrap().status, AgentStatus::Quarantined { .. }));
    let t = h.c.get_treasury();
    assert_eq!(t.reserved_for_intents.0, 0);
    assert_eq!(t.liquid.0, near(140));
    assert!(get_created_receipts().iter().all(|r| r.receiver_id != mpc()), "no MPC signature for a rejected intent");
}

#[test]
#[should_panic(expected = "AEGIS_E_AGENT_NOT_ACTIVE")]
fn quarantined_agent_cannot_request_settlement() {
    let (mut h, rhea, _) = intent_setup();
    h.owner_ctx(0);
    h.c.freeze_agent(rhea.id.clone(), "manual review".into());
    h.agent_ctx(&rhea);
    h.c.request_intent_settlement(h.intent(&rhea, near(1), "arb", USDC_ARB, "intents.near", 3, true));
}

#[test]
fn forged_intent_signature_is_critical() {
    let (mut h, rhea, _) = intent_setup();
    let mut req = h.intent(&rhea, near(2), "arb", USDC_ARB, "intents.near", 4, true);
    req.recipient = "0x000000000000000000000000000000000000beef".into(); // tampered after signing
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(req);
    assert_eq!(out.status, IntentStatus::Rejected);
    assert!(out.decision.violations.contains(&PolicyViolation::InvalidIntentSignature));
    assert!(out.quarantined);
}

#[test]
fn nonce_replay_is_detected() {
    let (mut h, rhea, _) = intent_setup();
    let req = h.intent(&rhea, near(2), "arb", USDC_ARB, "intents.near", 5, false);
    let mut first = req.clone();
    first.attestation = h.intent(&rhea, near(2), "arb", USDC_ARB, "intents.near", 5, true).attestation;
    h.agent_ctx(&rhea);
    assert_eq!(h.c.request_intent_settlement(first).status, IntentStatus::Signing);
    h.agent_ctx(&rhea);
    let replay = h.c.request_intent_settlement(req);
    assert!(replay.decision.violations.contains(&PolicyViolation::NonceReused));
    assert!(replay.quarantined);
}

#[test]
fn velocity_burst_trips_breaker() {
    let (mut h, rhea, _) = intent_setup();
    h.owner_ctx(0);
    let mut policy = h.c.get_global_policy();
    policy.velocity_limit = 2;
    policy.require_tee_attestation = false;
    h.c.update_global_policy(policy);
    for seed in 10..12u8 {
        h.agent_ctx(&rhea);
        assert_eq!(
            h.c.request_intent_settlement(h.intent(&rhea, near(1), "arb", USDC_ARB, "intents.near", seed, false)).status,
            IntentStatus::Signing
        );
        h.advance(5);
    }
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(h.intent(&rhea, near(1), "arb", USDC_ARB, "intents.near", 12, false));
    assert!(out.decision.violations.iter().any(|v| matches!(v, PolicyViolation::VelocityExceeded { requests: 3, .. })));
    assert!(out.quarantined);
}

#[test]
fn large_intent_waits_for_dao_approval() {
    let (mut h, rhea, _) = intent_setup();
    h.owner_ctx(0);
    let mut policy = h.c.get_global_policy();
    policy.dao_approval_threshold = U128(near(10));
    h.c.update_global_policy(policy);
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(h.intent(&rhea, near(12), "arb", USDC_ARB, "intents.near", 6, true));
    assert_eq!(out.status, IntentStatus::PendingApproval);
    assert!(get_created_receipts().iter().all(|r| r.receiver_id != mpc()), "no MPC call before approval");
    h.owner_ctx(0);
    assert_eq!(h.c.approve_intent(out.intent_id).status, IntentStatus::Signing);
}

#[test]
#[should_panic(expected = "recipients are `<chain>:<address>`, EVM addresses lower-case")]
fn policy_rejects_mixed_case_evm_recipients() {
    let mut h = H::new();
    h.owner_ctx(0);
    let mut policy = h.c.get_global_policy();
    policy.allowed_recipients.push(format!("arb:{VENDOR_EVM}"));
    h.c.update_global_policy(policy);
}

// EVM transfers through Chain Signatures

#[test]
fn eip1559_encoding_matches_a_hand_derived_vector() {
    set_ctx(&contract(), &contract(), None, 0, T0, 10, vec![]);
    let to: [u8; 20] = crate::codec::from_hex(VENDOR_EVM).unwrap().try_into().unwrap();
    let fields = crate::evm::eip1559_fields(84_532, 0, 1_000_000_000, 2_000_000_000, 21_000, &to, 1_000_000_000_000_000, &[]);
    let unsigned = crate::evm::typed_tx(&fields);
    let expected = format!(
        "02f1{}{}{}{}{}94{}{}{}c0",
        "83014a34",
        "80",
        "843b9aca00",
        "8477359400",
        "825208",
        VENDOR_EVM[2..].to_lowercase(),
        "87038d7ea4c68000",
        "80"
    );
    assert_eq!(to_hex(&unsigned), expected);
    let signed = crate::evm::signed_typed_tx(&fields, 1, &[0xab; 32], &[0x0c; 32]);
    // 49 bytes of fields + 01 + a0||32 bytes + a0||32 bytes = 116 bytes: a long list header (f8 74).
    assert_eq!(to_hex(&signed[..3]), "02f874");
    let data = crate::evm::erc20_transfer_data(&to, 5_000_000);
    assert_eq!(to_hex(&data[..4]), "a9059cbb");
    assert_eq!(data.len(), 68);
    assert_eq!(to_hex(&data[64..]), "004c4b40");
}

#[test]
fn evm_transfer_is_built_signed_and_confirmed() {
    let (mut h, rhea, sentinel) = intent_setup();
    let req = h.attested_evm_request(&rhea, VENDOR_EVM, "native", 1_000_000_000_000_000, "evm-audit-0001");
    let preview = h.c.preview_evm_transfer(req.clone());
    assert_eq!(preview.chain_id.0, 84_532);
    assert_eq!(preview.tx_to, VENDOR_EVM.to_lowercase());
    h.agent_ctx(&rhea);
    let out = h.c.request_evm_transfer(req);
    assert_eq!(out.status, EvmTxStatus::Signing, "{:?}", out.violations);
    assert_eq!(out.signing_hash, preview.signing_hash);
    let sign_call = get_created_receipts().into_iter().find(|r| r.receiver_id == mpc()).expect("MPC sign receipt");
    let args = sign_call
        .actions
        .iter()
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"sign" => Some(String::from_utf8(args.clone()).unwrap()),
            _ => None,
        })
        .unwrap();
    assert!(args.contains("aegis-treasury/basesepolia") && args.contains(&preview.signing_hash));
    assert_eq!(h.c.get_evm_spend("basesepolia".into(), "native".into()).0, 1_000_000_000_000_000);

    h.callback_ctx(vec![PromiseResult::Successful(mpc_response())]);
    assert_eq!(h.c.on_evm_signature(out.tx_id, U64(h.epoch)), EvmTxStatus::Signed);
    let record = h.c.get_evm_tx(out.tx_id).unwrap();
    let raw = record.raw_tx.clone().unwrap();
    assert!(raw.starts_with("0x02f8"));
    let raw_bytes = crate::codec::from_hex(&raw).unwrap();
    assert_eq!(record.tx_hash.clone().unwrap(), format!("0x{}", to_hex(&near_sdk::env::keccak256_array(&raw_bytes))));
    assert!(raw.contains(&"ab".repeat(32)) && raw.contains(&"cd".repeat(32)), "r and s are in the signed transaction");

    h.agent_ctx(&sentinel);
    let confirmed = h.c.confirm_evm_transfer(out.tx_id, record.tx_hash.unwrap().to_uppercase().replace("0X", "0x"));
    assert_eq!(confirmed.status, EvmTxStatus::Confirmed);
}

#[test]
fn evm_transfer_to_an_unknown_address_is_critical() {
    let (mut h, rhea, _) = intent_setup();
    let req = h.attested_evm_request(&rhea, ATTACKER_EVM, "native", 1_000_000_000_000_000, "evm-audit-0002");
    h.agent_ctx(&rhea);
    let out = h.c.request_evm_transfer(req);
    assert_eq!(out.status, EvmTxStatus::Rejected);
    assert!(out.violations.iter().any(|v| matches!(v, PolicyViolation::RecipientNotAllowed { .. })));
    assert!(out.quarantined);
    assert!(get_created_receipts().iter().all(|r| r.receiver_id != mpc()), "nothing is signed");
}

#[test]
fn evm_limits_fees_and_unknown_tokens_are_enforced() {
    let (mut h, rhea, _) = intent_setup();
    h.owner_ctx(0);
    let mut policy = h.c.get_global_policy();
    policy.require_tee_attestation = false;
    h.c.update_global_policy(policy);

    let mut big = h.evm_request(VENDOR_EVM, "native", 20_000_000_000_000_000);
    big.max_fee_per_gas = U128(100_000_000_000_000);
    h.agent_ctx(&rhea);
    let out = h.c.request_evm_transfer(big);
    let codes: Vec<&str> = out.violations.iter().map(|v| v.code()).collect();
    assert!(codes.contains(&"evm_amount_exceeds_limit") && codes.contains(&"evm_fee_too_high"), "{codes:?}");
    assert_eq!(out.severity, Severity::Warning);
    assert!(!out.quarantined, "a first warning is a strike");

    let token = h.evm_request(VENDOR_EVM, "0x1111111111111111111111111111111111111111", 1_000);
    h.agent_ctx(&rhea);
    let out = h.c.request_evm_transfer(token);
    assert!(out.violations.iter().any(|v| matches!(v, PolicyViolation::EvmAssetNotAllowed { .. })));
    assert!(out.quarantined);
}

#[test]
fn erc20_transfer_signs_token_calldata() {
    let (mut h, rhea, _) = intent_setup();
    let req = h.attested_evm_request(&rhea, VENDOR_EVM, BASE_SEPOLIA_USDC, 2_500_000, "evm-audit-0003");
    let preview = h.c.preview_evm_transfer(req.clone());
    assert_eq!(preview.tx_to, BASE_SEPOLIA_USDC);
    assert_eq!(preview.tx_value.0, 0);
    assert!(preview.data.starts_with("a9059cbb") && preview.data.ends_with("2625a0"));
    h.agent_ctx(&rhea);
    assert_eq!(h.c.request_evm_transfer(req).status, EvmTxStatus::Signing);
}

// Kill switch

#[test]
fn kill_switch_blocks_agents_and_only_owner_resumes() {
    let (mut h, rhea, sentinel) = intent_setup();
    h.agent_ctx(&sentinel);
    h.c.set_protocol_paused(true, "anomaly detected".into());
    assert!(h.c.is_paused());
    h.agent_ctx(&rhea);
    let out = h.c.request_intent_settlement(h.intent(&rhea, near(1), "arb", USDC_ARB, "intents.near", 8, true));
    assert_eq!(out.decision.violations, vec![PolicyViolation::ProtocolPaused]);
    assert_eq!(out.decision.severity, Severity::Notice);
    assert_eq!(h.c.get_agent(rhea.id).unwrap().violations, 0, "notices are not strikes");
    h.owner_ctx(0);
    h.c.set_protocol_paused(false, "resolved".into());
    assert!(!h.c.is_paused());
}

#[test]
#[should_panic(expected = "AEGIS_E_ONLY_OWNER_CAN_RESUME")]
fn sentinel_cannot_resume_protocol() {
    let (h, _rhea, sentinel) = intent_setup();
    let mut h = h;
    h.agent_ctx(&sentinel);
    h.c.set_protocol_paused(true, "anomaly".into());
    h.agent_ctx(&sentinel);
    h.c.set_protocol_paused(false, "resume".into());
}

#[test]
fn sentinel_report_quarantines_target_and_owner_reinstates_key() {
    let (mut h, _rhea, sentinel) = intent_setup();
    let rogue = h.spawn("mallory-rogue-worker", AgentRole::ComputeWorker, SpawnMode::ContractKey, 66);
    h.agent_ctx(&sentinel);
    assert!(h.c.report_agent(rogue.id.clone(), "wash-trading pattern".into(), sha_hex("evidence")));
    assert!(matches!(h.c.get_agent(rogue.id.clone()).unwrap().status, AgentStatus::Quarantined { .. }));
    assert_eq!(h.c.get_treasury().contract_key_allowances.0, 0);
    h.owner_ctx(0);
    h.c.reinstate_agent(rogue.id.clone());
    let re_add = get_created_receipts().into_iter().find(|r| r.receiver_id == contract()).unwrap();
    assert!(re_add.actions.iter().any(|a| matches!(a, MockAction::AddKeyWithFunctionCall { .. })));
    let agent = h.c.get_agent(rogue.id).unwrap();
    assert_eq!(agent.status, AgentStatus::Active);
    assert!(agent.key_active);
    assert_eq!(h.c.get_treasury().contract_key_allowances.0, near(1) / 4);
}

// Revenue

#[test]
fn revenue_distribution_splits_profit_by_bps() {
    let mut h = H::new();
    h.fund(100, 40);
    h.account_ctx(&acc("keeper.testnet"), 0);
    let d = h.c.distribute_revenue();
    assert_eq!(d.total.0, near(40));
    assert_eq!(d.retained.0, near(12));
    let legs: Vec<(String, u128)> = d.payouts.iter().map(|l| (l.account_id.to_string(), l.amount.0)).collect();
    assert_eq!(legs, vec![(owner().to_string(), near(20)), ("ops-guild.testnet".to_string(), near(8))]);
    let receipts = get_created_receipts();
    for (account, amount) in &legs {
        let r = receipts.iter().find(|r| r.receiver_id.as_str() == account).unwrap();
        assert!(r.actions.iter().any(|a| matches!(a, MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == *amount)));
    }
    let t = h.c.get_treasury();
    assert_eq!(t.liquid.0, near(140 - 28));
    assert_eq!(t.total_distributed.0, near(28));
    assert_eq!(t.total_retained.0, near(12));
    assert_eq!(t.distributable_profit.0, 0);

    // One leg bounces: it is credited back to the treasury.
    h.callback_ctx(vec![PromiseResult::Successful(vec![]), PromiseResult::Failed]);
    assert_eq!(h.c.on_distribution_settled(d.distribution_id, d.payouts.clone()).0, near(8));
    assert_eq!(h.c.get_treasury().liquid.0, near(140 - 20));
    assert_eq!(h.c.list_distributions(None)[0].failed.0, near(8));
}

#[test]
#[should_panic(expected = "AEGIS_E_BELOW_MIN_DISTRIBUTION")]
fn distribution_without_profit_is_rejected() {
    let mut h = H::new();
    h.fund(100, 0);
    h.account_ctx(&acc("keeper.testnet"), 0);
    h.c.distribute_revenue();
}

// Parity

/// Golden vector shared with `packages/agent-swarm-sdk/test/parity.test.ts`.
#[test]
fn nep413_golden_vector_matches_typescript_sdk() {
    set_ctx(&contract(), &contract(), None, 0, T0, 10, vec![]);
    let req = CrossChainIntentRequest {
        kind: IntentKind::Swap,
        destination_chain: "arb".into(),
        origin_asset: WNEAR.into(),
        destination_asset: USDC_ARB.into(),
        amount: U128(near(12)),
        min_amount_out: U128(56_282_000),
        recipient: VENDOR_EVM.into(),
        execution_contract: acc("intents.near"),
        slippage_bps: 50,
        deadline_ns: U64(T0 + 900 * SEC),
        quote: Some(QuoteBinding {
            provider: "1click".into(),
            quote_hash: "ab".repeat(32),
            correlation_id: "golden".into(),
            amount_in: U128(near(12)),
            amount_out: U128(56_564_000),
            min_amount_out: U128(56_282_000),
            expires_at_ns: U64(T0 + 600 * SEC),
            dry: true,
            deposit_address: None,
        }),
        nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=".into(),
        signature: String::new(),
        attestation: None,
        memo: Some("golden".into()),
    };
    let message = build_intent_message("rhea-yield-strategist.aegis-swarm.testnet", &req);
    let expected = concat!(
        r#"{"aegis":{"chain":"arb","contract":"intents.near","kind":"swap","memo":"golden","quote_hash":""#,
        "abababababababababababababababababababababababababababababababab",
        r#"","recipient":"0x2527D02599Ba641c19FEa793cD0F167589a0f10D"},"deadline":"2026-11-01T00:15:00.000Z","#,
        r#""intents":[{"diff":{"nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near":"56282000","#,
        r#""nep141:wrap.near":"-12000000000000000000000000"},"intent":"token_diff"}],"#,
        r#""signer_id":"rhea-yield-strategist.aegis-swarm.testnet"}"#
    );
    assert_eq!(message, expected);

    // Independent byte layout: tag || len || message || nonce || len || recipient || None.
    let mut bytes = 2_147_484_061u32.to_le_bytes().to_vec();
    bytes.extend((message.len() as u32).to_le_bytes());
    bytes.extend(message.as_bytes());
    bytes.extend([7u8; 32]);
    bytes.extend(("aegis-swarm.testnet".len() as u32).to_le_bytes());
    bytes.extend(b"aegis-swarm.testnet");
    bytes.push(0);
    let hash = nep413_hash(&message, &[7u8; 32], "aegis-swarm.testnet");
    assert_eq!(hash, near_sdk::env::sha256_array(&bytes));
    assert_eq!(to_hex(&hash), GOLDEN_NEP413_HASH);
}

const GOLDEN_NEP413_HASH: &str = "6d05b091626ad3c576d82c18c3d58c1608bb2f5ecbeb2a02febfb530fe3c7a9e";

//! TEE / Private AI attestation verification (tracks: privacy, security).
//!
//! Two kinds of proof release escrow and authorize settlements:
//!
//! * `ExecutionProof::NearAi`: a NEAR AI Cloud chat completion signed inside the model's TEE.
//!   NEAR AI signs `"<sha256(request body)>:<sha256(response body)>"` with an ed25519 key that
//!   its Intel TDX attestation binds (`report_data = signing_key || nonce`). The owner registers
//!   that key after verifying the attestation off-chain (`EnclaveKind::NearAiModel`); anyone can
//!   re-check the same binding with `pnpm verify:live`. On-chain, the contract hashes the exact
//!   request and response bodies, verifies the signature with `env::ed25519_verify`, checks that
//!   the request carries the binding marker for this subject, agent, input and nonce, and reads
//!   the model's verdict from the signed response. The agent cannot change any of these bytes.
//! * Pinned prompt: the agent that submits a NEAR AI proof also wrote the request, so a valid
//!   signature alone only shows which model answered. The contract therefore accepts a NEAR AI
//!   proof only if the request is a single turn whose system message is a template pinned on-chain
//!   (`sha256` in the task's `VerificationSchema.prompt_hash`, or `GlobalPolicy.audit_prompt_hash`
//!   for settlement and EVM audits) followed by the binding line, with deterministic sampling, JSON
//!   mode and no other request fields except `chat_template_kwargs: {"enable_thinking": false}`
//!   (reasoning off). Tasks with `input_pinned` also fix the user message: it must
//!   be the exact spec whose sha256 is `spec_hash`. Settlement and EVM audits fix it too: it must be
//!   the audit facts the contract builds from its own evaluation (`facts.rs`), so an agent can write
//!   neither the auditor's instructions nor its evidence. For tasks without `input_pinned` the user
//!   message is data the agent chose; it is public in the proof transaction.
//! * `ExecutionProof::Receipt`: an `ExecutionReceipt` signed by a self-hosted enclave key
//!   (`EnclaveKind::ReceiptSigner`), for CVMs that sign their own receipt format.
//!
//! The contract stores only hashes of inputs and outputs. A NEAR AI proof transaction carries the
//! request and response bodies as arguments, so those bodies are public on-chain.

use near_sdk::json_types::U64;
use near_sdk::serde::Deserialize;
use near_sdk::{env, near, require, serde_json, AccountId, PublicKey};

use crate::codec::{
    decode_ed25519_signature, decode_ed25519_signature_any, ed25519_key_bytes, is_hash32_hex, is_measurement_hex, is_nonce_label,
    is_safe_ascii, to_hex,
};
use crate::events::PhalanxEvent;
use crate::{PhalanxCore, PhalanxCoreExt};

/// Domain separator mixed into every receipt digest.
pub const RECEIPT_DOMAIN: &str = "PHALANX_TEE_RECEIPT_V1";
/// Prefix of the marker an agent puts in every NEAR AI request it wants to use as a proof.
pub const NEARAI_BIND_PREFIX: &str = "PHALANX-BIND:v1";
/// Joins the pinned system prompt and the binding marker in a NEAR AI proof request.
pub const NEARAI_BIND_LINE: &str = "\n\nBinding (copy nothing from it): ";
/// Accepted clock skew for `issued_at_ns` in the future.
pub const MAX_FUTURE_SKEW_NS: u64 = 60_000_000_000;
/// Upper bound for request / response bodies carried in a NEAR AI proof.
pub const MAX_PROOF_BODY_BYTES: usize = 24_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnclaveKind {
    /// Signs `ExecutionReceipt` digests (self-hosted CVM).
    ReceiptSigner,
    /// A NEAR AI Cloud model whose response-signing key is bound by its TDX attestation.
    NearAiModel,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnclaveRecord {
    pub enclave_id: String,
    pub kind: EnclaveKind,
    /// Hex code measurement of the approved image (Intel TDX `mr_td` for NEAR AI models).
    pub measurement: String,
    /// ed25519 key the enclave signs receipts / responses with.
    pub signer_public_key: PublicKey,
    pub vendor: String,
    pub model_id: String,
    pub tee_type: String,
    /// Where the binding of key and measurement can be re-verified (report hash, URL, ...).
    pub attestation_ref: String,
    pub active: bool,
    pub registered_at_ns: U64,
    pub receipts_verified: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionReceipt {
    /// `task` (swarm task execution) or `intent` (sentinel audit of a settlement request).
    pub subject_kind: String,
    pub subject_id: U64,
    /// Agent on whose behalf the enclave ran.
    pub agent_id: AccountId,
    pub enclave_id: String,
    pub measurement: String,
    pub model_id: String,
    /// Hex sha256 of the private input (task spec, NEP-413 hash, or EVM signing hash).
    pub input_hash: String,
    /// Hex sha256 of the private output (for NEAR AI: the signed response hash).
    pub output_hash: String,
    /// Hex sha256 of the output schema the task demanded.
    pub schema_hash: String,
    /// `completed` for tasks, `approve` / `reject` for audits.
    pub verdict: String,
    pub confidence_bps: u32,
    pub issued_at_ns: U64,
    pub nonce: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedReceipt {
    pub receipt: ExecutionReceipt,
    /// `ed25519:<base58>` signature over `compute_receipt_digest(receipt)`.
    pub signature: String,
}

/// A NEAR AI Cloud completion, exactly as it went over the wire, plus the TEE signature.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NearAiProof {
    pub enclave_id: String,
    pub chat_id: String,
    pub subject_kind: String,
    pub subject_id: U64,
    pub agent_id: AccountId,
    pub input_hash: String,
    pub schema_hash: String,
    pub nonce: String,
    pub issued_at_ns: U64,
    /// Exact JSON request body sent to `/v1/chat/completions`.
    pub request_body: String,
    /// Exact response body received.
    pub response_body: String,
    /// `text` from `/v1/signature/{chat_id}`: `[prefix:]<request sha256>:<response sha256>`.
    pub signed_text: String,
    /// ed25519 signature over `signed_text` (hex or `ed25519:<base58>`).
    pub signature: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionProof {
    Receipt(SignedReceipt),
    NearAi(NearAiProof),
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationRecord {
    pub receipt_hash: String,
    /// `receipt` or `near_ai`.
    pub proof_kind: String,
    pub receipt: ExecutionReceipt,
    pub verified_at_ns: U64,
    pub block_height: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationCheck {
    pub valid: bool,
    pub receipt_hash: String,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestationError {
    MalformedReceipt,
    UnknownEnclave,
    EnclaveInactive,
    WrongEnclaveKind,
    MeasurementMismatch,
    AgentMismatch,
    SubjectMismatch,
    SchemaMismatch,
    InputMismatch,
    VerdictRejected,
    LowConfidence,
    FutureReceipt,
    StaleReceipt,
    Replayed,
    MalformedSignature,
    BadSignature,
    BodyHashMismatch,
    BindingMissing,
    ModelMismatch,
    UnparseableVerdict,
    /// No prompt is pinned for this subject, so only enclave receipts can prove it.
    PromptNotPinned,
    /// The request is not exactly the pinned prompt (instructions, input, turns or sampling).
    PromptMismatch,
    /// An audit's user message is not the facts document the contract built for the request.
    FactsMismatch,
}

impl AttestationError {
    pub fn reason(&self) -> &'static str {
        match self {
            Self::MalformedReceipt => "malformed_receipt",
            Self::UnknownEnclave => "unknown_enclave",
            Self::EnclaveInactive => "enclave_inactive",
            Self::WrongEnclaveKind => "wrong_enclave_kind",
            Self::MeasurementMismatch => "measurement_mismatch",
            Self::AgentMismatch => "agent_mismatch",
            Self::SubjectMismatch => "subject_mismatch",
            Self::SchemaMismatch => "schema_mismatch",
            Self::InputMismatch => "input_mismatch",
            Self::VerdictRejected => "verdict_rejected",
            Self::LowConfidence => "low_confidence",
            Self::FutureReceipt => "future_receipt",
            Self::StaleReceipt => "stale_receipt",
            Self::Replayed => "replayed_receipt",
            Self::MalformedSignature => "malformed_signature",
            Self::BadSignature => "bad_signature",
            Self::BodyHashMismatch => "body_hash_mismatch",
            Self::BindingMissing => "binding_missing",
            Self::ModelMismatch => "model_mismatch",
            Self::UnparseableVerdict => "unparseable_verdict",
            Self::PromptNotPinned => "prompt_not_pinned",
            Self::PromptMismatch => "prompt_mismatch",
            Self::FactsMismatch => "facts_mismatch",
        }
    }

    /// Errors that can only come from a forged or replayed proof (scam detection).
    pub fn is_forgery(&self) -> bool {
        matches!(
            self,
            Self::UnknownEnclave
                | Self::WrongEnclaveKind
                | Self::MeasurementMismatch
                | Self::Replayed
                | Self::MalformedSignature
                | Self::BadSignature
                | Self::BodyHashMismatch
                | Self::BindingMissing
                | Self::ModelMismatch
                | Self::PromptMismatch
                | Self::FactsMismatch
        )
    }
}

/// What the caller expects a proof to attest to.
pub struct ReceiptExpectation<'a> {
    pub subject_kind: &'a str,
    pub subject_id: u64,
    pub agent_id: &'a AccountId,
    pub schema_hash: Option<&'a str>,
    pub input_hash: Option<&'a str>,
    pub verdict: &'a str,
    pub min_confidence_bps: u32,
    /// Hex sha256 of the system prompt a NEAR AI proof must use. `None` rejects NEAR AI proofs.
    pub prompt_hash: Option<&'a str>,
    /// Hex sha256 the NEAR AI user message must have, and the error a mismatch reports: the task
    /// spec for `input_pinned` tasks (`PromptMismatch`), the contract's audit facts for settlement
    /// and EVM audits (`FactsMismatch`). `None`: the agent chose the user message.
    pub user_message: Option<(&'a str, AttestationError)>,
}

fn push_str(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

/// Borsh-compatible signing bytes: every string is `u32 LE length || utf8`, integers are LE.
pub fn receipt_signing_bytes(r: &ExecutionReceipt) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);
    push_str(&mut buf, RECEIPT_DOMAIN);
    push_str(&mut buf, &r.subject_kind);
    buf.extend_from_slice(&r.subject_id.0.to_le_bytes());
    push_str(&mut buf, r.agent_id.as_str());
    push_str(&mut buf, &r.enclave_id);
    push_str(&mut buf, &r.measurement);
    push_str(&mut buf, &r.model_id);
    push_str(&mut buf, &r.input_hash);
    push_str(&mut buf, &r.output_hash);
    push_str(&mut buf, &r.schema_hash);
    push_str(&mut buf, &r.verdict);
    buf.extend_from_slice(&r.confidence_bps.to_le_bytes());
    buf.extend_from_slice(&r.issued_at_ns.0.to_le_bytes());
    push_str(&mut buf, &r.nonce);
    buf
}

pub fn receipt_digest(r: &ExecutionReceipt) -> [u8; 32] {
    env::sha256_array(receipt_signing_bytes(r))
}

/// The marker a NEAR AI request must contain to count as a proof for this subject.
pub fn near_ai_binding_marker(
    subject_kind: &str,
    subject_id: u64,
    agent_id: &str,
    input_hash: &str,
    nonce: &str,
    issued_at_ns: u64,
) -> String {
    format!("{NEARAI_BIND_PREFIX}:{subject_kind}:{subject_id}:{agent_id}:{input_hash}:{nonce}:{issued_at_ns}")
}

fn receipt_is_well_formed(r: &ExecutionReceipt) -> bool {
    matches!(r.subject_kind.as_str(), "task" | "intent" | "evm")
        && is_measurement_hex(&r.measurement)
        && is_hash32_hex(&r.input_hash)
        && is_hash32_hex(&r.output_hash)
        && is_hash32_hex(&r.schema_hash)
        && is_safe_ascii(&r.enclave_id, 64)
        && is_safe_ascii(&r.model_id, 96)
        && is_safe_ascii(&r.verdict, 16)
        && is_safe_ascii(&r.nonce, 64)
        && !r.nonce.is_empty()
        && r.confidence_bps <= 10_000
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChatCompletion {
    id: Option<String>,
    model: Option<String>,
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ModelVerdict {
    verdict: String,
    confidence_bps: Option<u32>,
}

/// The model's verdict: the JSON object in `choices[0].message.content`.
fn parse_model_verdict(response_body: &str) -> Result<(Option<String>, Option<String>, ModelVerdict), AttestationError> {
    let completion: ChatCompletion = serde_json::from_str(response_body).map_err(|_| AttestationError::UnparseableVerdict)?;
    let content =
        completion.choices.first().and_then(|c| c.message.content.as_deref()).ok_or(AttestationError::UnparseableVerdict)?;
    let start = content.find('{').ok_or(AttestationError::UnparseableVerdict)?;
    let end = content.rfind('}').ok_or(AttestationError::UnparseableVerdict)?;
    if end <= start {
        return Err(AttestationError::UnparseableVerdict);
    }
    let verdict: ModelVerdict = serde_json::from_str(&content[start..=end]).map_err(|_| AttestationError::UnparseableVerdict)?;
    Ok((completion.id, completion.model, verdict))
}

/// The only request shape a NEAR AI proof may have. Unknown fields (`logit_bias`, `tools`,
/// `response_format` schemas, extra turns, ...) could steer the model, so they are rejected.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ProofRequest {
    model: String,
    messages: Vec<ProofMessage>,
    temperature: serde_json::Value,
    // Parsed only so the shape is complete; any value is fine.
    #[allow(dead_code)]
    max_tokens: Option<u32>,
    response_format: ResponseFormat,
    /// Only `{"enable_thinking": false}`, which turns off the model's hidden reasoning. It adds no
    /// instructions, and without it NEAR AI's Qwen models can spend the whole token budget reasoning.
    #[serde(default)]
    chat_template_kwargs: Option<ChatTemplateKwargs>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ChatTemplateKwargs {
    enable_thinking: bool,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ProofMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ResponseFormat {
    #[serde(rename = "type")]
    kind: String,
}

/// Checks that a NEAR AI proof request is the pinned prompt: one system message (the pinned
/// template, the binding line and the marker) and one user message, `temperature` 0 and JSON
/// mode. With `user_message`, the user message must hash to its value, or the paired error is returned.
fn check_pinned_request(
    request_body: &str,
    prompt_hash: &str,
    marker: &str,
    user_message: Option<(&str, AttestationError)>,
) -> Result<(), AttestationError> {
    let req: ProofRequest = serde_json::from_str(request_body).map_err(|_| AttestationError::PromptMismatch)?;
    let [system, user] = req.messages.as_slice() else {
        return Err(AttestationError::PromptMismatch);
    };
    let deterministic = !req.model.is_empty()
        && req.temperature.as_u64() == Some(0)
        && req.response_format.kind == "json_object"
        && !req.chat_template_kwargs.as_ref().is_some_and(|k| k.enable_thinking);
    if !deterministic || system.role != "system" || user.role != "user" {
        return Err(AttestationError::PromptMismatch);
    }
    let template = system
        .content
        .strip_suffix(marker)
        .and_then(|s| s.strip_suffix(NEARAI_BIND_LINE))
        .ok_or(AttestationError::PromptMismatch)?;
    if to_hex(&env::sha256_array(template.as_bytes())) != prompt_hash {
        return Err(AttestationError::PromptMismatch);
    }
    if let Some((expected, mismatch)) = user_message {
        if to_hex(&env::sha256_array(user.content.as_bytes())) != expected {
            return Err(mismatch);
        }
    }
    Ok(())
}

/// Splits `[prefix:]<req hash>:<resp hash>` into the two hashes.
fn signed_hashes(text: &str) -> Option<(&str, &str)> {
    let parts: Vec<&str> = text.split(':').collect();
    let (req, resp) = match parts.len() {
        2 => (parts[0], parts[1]),
        3 => (parts[1], parts[2]),
        _ => return None,
    };
    (is_hash32_hex(req) && is_hash32_hex(resp)).then_some((req, resp))
}

impl PhalanxCore {
    fn check_freshness(&self, issued_at_ns: u64) -> Result<(), AttestationError> {
        let now = env::block_timestamp();
        if issued_at_ns > now.saturating_add(MAX_FUTURE_SKEW_NS) {
            return Err(AttestationError::FutureReceipt);
        }
        let max_age = self.config.max_receipt_age_sec.saturating_mul(1_000_000_000);
        if now.saturating_sub(issued_at_ns) > max_age {
            return Err(AttestationError::StaleReceipt);
        }
        Ok(())
    }

    /// Full verification of a self-hosted enclave receipt against the registry. Read-only.
    pub(crate) fn verify_receipt(&self, signed: &SignedReceipt, exp: &ReceiptExpectation) -> Result<String, AttestationError> {
        let r = &signed.receipt;
        if !receipt_is_well_formed(r) {
            return Err(AttestationError::MalformedReceipt);
        }
        let enclave = self.enclaves.get(&r.enclave_id).ok_or(AttestationError::UnknownEnclave)?;
        if enclave.kind != EnclaveKind::ReceiptSigner {
            return Err(AttestationError::WrongEnclaveKind);
        }
        if r.measurement != enclave.measurement {
            return Err(AttestationError::MeasurementMismatch);
        }
        let sig = decode_ed25519_signature(&signed.signature).ok_or(AttestationError::MalformedSignature)?;
        let pk = ed25519_key_bytes(&enclave.signer_public_key).ok_or(AttestationError::UnknownEnclave)?;
        let digest = receipt_digest(r);
        if !env::ed25519_verify(&sig, digest, &pk) {
            return Err(AttestationError::BadSignature);
        }
        let hash = to_hex(&digest);
        if self.attestations.contains_key(&hash) {
            return Err(AttestationError::Replayed);
        }
        if !enclave.active {
            return Err(AttestationError::EnclaveInactive);
        }
        if &r.agent_id != exp.agent_id {
            return Err(AttestationError::AgentMismatch);
        }
        if r.subject_kind != exp.subject_kind || r.subject_id.0 != exp.subject_id {
            return Err(AttestationError::SubjectMismatch);
        }
        if let Some(schema) = exp.schema_hash {
            if r.schema_hash != schema {
                return Err(AttestationError::SchemaMismatch);
            }
        }
        if let Some(input) = exp.input_hash {
            if r.input_hash != input {
                return Err(AttestationError::InputMismatch);
            }
        }
        if r.verdict != exp.verdict {
            return Err(AttestationError::VerdictRejected);
        }
        if r.confidence_bps < exp.min_confidence_bps {
            return Err(AttestationError::LowConfidence);
        }
        self.check_freshness(r.issued_at_ns.0)?;
        Ok(hash)
    }

    /// Full verification of a NEAR AI signed completion. Read-only.
    pub(crate) fn verify_near_ai(
        &self,
        p: &NearAiProof,
        exp: &ReceiptExpectation,
    ) -> Result<(String, ExecutionReceipt), AttestationError> {
        let well_formed = matches!(p.subject_kind.as_str(), "task" | "intent" | "evm")
            && is_hash32_hex(&p.input_hash)
            && is_hash32_hex(&p.schema_hash)
            && is_nonce_label(&p.nonce)
            && is_safe_ascii(&p.chat_id, 128)
            && p.request_body.len() <= MAX_PROOF_BODY_BYTES
            && p.response_body.len() <= MAX_PROOF_BODY_BYTES;
        if !well_formed {
            return Err(AttestationError::MalformedReceipt);
        }
        let enclave = self.enclaves.get(&p.enclave_id).ok_or(AttestationError::UnknownEnclave)?;
        if enclave.kind != EnclaveKind::NearAiModel {
            return Err(AttestationError::WrongEnclaveKind);
        }
        let (req_hash, resp_hash) = signed_hashes(&p.signed_text).ok_or(AttestationError::MalformedSignature)?;
        let sig = decode_ed25519_signature_any(&p.signature).ok_or(AttestationError::MalformedSignature)?;
        let pk = ed25519_key_bytes(&enclave.signer_public_key).ok_or(AttestationError::UnknownEnclave)?;
        let text = p.signed_text.as_bytes();
        // NEAR AI signs the text; a signature over its sha256 is accepted as the same statement.
        if !env::ed25519_verify(&sig, text, &pk) && !env::ed25519_verify(&sig, env::sha256_array(text), &pk) {
            return Err(AttestationError::BadSignature);
        }
        if to_hex(&env::sha256_array(p.request_body.as_bytes())) != req_hash
            || to_hex(&env::sha256_array(p.response_body.as_bytes())) != resp_hash
        {
            return Err(AttestationError::BodyHashMismatch);
        }
        let hash = to_hex(&env::sha256_array(text));
        if self.attestations.contains_key(&hash) || self.used_nonces.contains(&format!("proof:{}:{}", p.agent_id, p.nonce)) {
            return Err(AttestationError::Replayed);
        }
        let marker = near_ai_binding_marker(
            &p.subject_kind,
            p.subject_id.0,
            p.agent_id.as_str(),
            &p.input_hash,
            &p.nonce,
            p.issued_at_ns.0,
        );
        if !p.request_body.contains(&marker) {
            return Err(AttestationError::BindingMissing);
        }
        if !enclave.active {
            return Err(AttestationError::EnclaveInactive);
        }
        let pinned = exp.prompt_hash.ok_or(AttestationError::PromptNotPinned)?;
        check_pinned_request(&p.request_body, pinned, &marker, exp.user_message)?;
        let (chat_id, model, verdict) = parse_model_verdict(&p.response_body)?;
        if model.as_deref().is_some_and(|m| m != enclave.model_id) {
            return Err(AttestationError::ModelMismatch);
        }
        if chat_id.as_deref().is_some_and(|id| id != p.chat_id) {
            return Err(AttestationError::MalformedReceipt);
        }
        if &p.agent_id != exp.agent_id {
            return Err(AttestationError::AgentMismatch);
        }
        if p.subject_kind != exp.subject_kind || p.subject_id.0 != exp.subject_id {
            return Err(AttestationError::SubjectMismatch);
        }
        if let Some(schema) = exp.schema_hash {
            if p.schema_hash != schema {
                return Err(AttestationError::SchemaMismatch);
            }
        }
        if let Some(input) = exp.input_hash {
            if p.input_hash != input {
                return Err(AttestationError::InputMismatch);
            }
        }
        if verdict.verdict != exp.verdict {
            return Err(AttestationError::VerdictRejected);
        }
        let confidence = verdict.confidence_bps.unwrap_or(0).min(10_000);
        if confidence < exp.min_confidence_bps {
            return Err(AttestationError::LowConfidence);
        }
        self.check_freshness(p.issued_at_ns.0)?;
        let receipt = ExecutionReceipt {
            subject_kind: p.subject_kind.clone(),
            subject_id: p.subject_id,
            agent_id: p.agent_id.clone(),
            enclave_id: p.enclave_id.clone(),
            measurement: enclave.measurement.clone(),
            model_id: enclave.model_id.clone(),
            input_hash: p.input_hash.clone(),
            output_hash: resp_hash.to_string(),
            schema_hash: p.schema_hash.clone(),
            verdict: verdict.verdict,
            confidence_bps: confidence,
            issued_at_ns: p.issued_at_ns,
            nonce: p.nonce.clone(),
        };
        Ok((hash, receipt))
    }

    /// Verifies either proof kind and returns its hash and the receipt summary to record.
    pub(crate) fn verify_proof(
        &self,
        proof: &ExecutionProof,
        exp: &ReceiptExpectation,
    ) -> Result<(String, ExecutionReceipt), AttestationError> {
        match proof {
            ExecutionProof::Receipt(signed) => self.verify_receipt(signed, exp).map(|h| (h, signed.receipt.clone())),
            ExecutionProof::NearAi(p) => self.verify_near_ai(p, exp),
        }
    }

    pub(crate) fn record_attestation(&mut self, hash: &str, proof: &ExecutionProof, receipt: &ExecutionReceipt) {
        let proof_kind = match proof {
            ExecutionProof::Receipt(_) => "receipt",
            ExecutionProof::NearAi(p) => {
                self.used_nonces.insert(format!("proof:{}:{}", p.agent_id, p.nonce));
                "near_ai"
            }
        };
        let record = AttestationRecord {
            receipt_hash: hash.to_string(),
            proof_kind: proof_kind.to_string(),
            receipt: receipt.clone(),
            verified_at_ns: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
        };
        self.attestations.insert(hash.to_string(), record);
        self.attestation_log.push(hash.to_string());
        if let Some(enclave) = self.enclaves.get_mut(&receipt.enclave_id) {
            enclave.receipts_verified += 1;
        }
        PhalanxEvent::AttestationVerified {
            receipt_hash: hash.to_string(),
            enclave_id: receipt.enclave_id.clone(),
            agent_id: receipt.agent_id.clone(),
            subject: format!("{}:{}", receipt.subject_kind, receipt.subject_id.0),
        }
        .emit();
    }
}

#[near]
impl PhalanxCore {
    /// Owner-only. Adds (or rotates) a trusted enclave or attested NEAR AI model key.
    #[allow(clippy::too_many_arguments)]
    pub fn register_enclave(
        &mut self,
        enclave_id: String,
        measurement: String,
        signer_public_key: PublicKey,
        vendor: String,
        model_id: String,
        tee_type: String,
        kind: Option<EnclaveKind>,
        attestation_ref: Option<String>,
    ) -> EnclaveRecord {
        self.assert_owner();
        require!(is_safe_ascii(&enclave_id, 64) && !enclave_id.is_empty(), "PHALANX_E_INVALID_ENCLAVE_ID");
        require!(is_measurement_hex(&measurement), "PHALANX_E_INVALID_MEASUREMENT");
        require!(ed25519_key_bytes(&signer_public_key).is_some(), "PHALANX_E_ED25519_KEY_REQUIRED");
        require!(
            is_safe_ascii(&vendor, 96) && is_safe_ascii(&model_id, 96) && is_safe_ascii(&tee_type, 48),
            "PHALANX_E_INVALID_ENCLAVE_METADATA"
        );
        let attestation_ref = attestation_ref.unwrap_or_default();
        require!(is_safe_ascii(&attestation_ref, 160), "PHALANX_E_INVALID_ATTESTATION_REF");
        let record = EnclaveRecord {
            enclave_id: enclave_id.clone(),
            kind: kind.unwrap_or(EnclaveKind::ReceiptSigner),
            measurement: measurement.to_lowercase(),
            signer_public_key,
            vendor: vendor.clone(),
            model_id,
            tee_type,
            attestation_ref,
            active: true,
            registered_at_ns: U64(env::block_timestamp()),
            receipts_verified: 0,
        };
        self.enclaves.insert(enclave_id.clone(), record.clone());
        PhalanxEvent::EnclaveRegistered { enclave_id, measurement: record.measurement.clone(), vendor }.emit();
        record
    }

    pub fn set_enclave_active(&mut self, enclave_id: String, active: bool) {
        self.assert_owner();
        let enclave = self.enclaves.get_mut(&enclave_id).unwrap_or_else(|| env::panic_str("PHALANX_E_UNKNOWN_ENCLAVE"));
        enclave.active = active;
    }

    /// Checks a proof's enclave, signature, bindings and freshness without recording it.
    /// A NEAR AI proof also needs `prompt_hash`, the pinned system prompt it claims to use.
    pub fn verify_attestation(&self, proof: ExecutionProof, prompt_hash: Option<String>) -> AttestationCheck {
        let (kind, id, agent, verdict, schema) = match &proof {
            ExecutionProof::Receipt(s) => (
                s.receipt.subject_kind.clone(),
                s.receipt.subject_id.0,
                s.receipt.agent_id.clone(),
                s.receipt.verdict.clone(),
                None,
            ),
            ExecutionProof::NearAi(p) => {
                let verdict = parse_model_verdict(&p.response_body).map(|v| v.2.verdict).unwrap_or_default();
                (p.subject_kind.clone(), p.subject_id.0, p.agent_id.clone(), verdict, Some(p.schema_hash.clone()))
            }
        };
        let exp = ReceiptExpectation {
            subject_kind: &kind,
            subject_id: id,
            agent_id: &agent,
            schema_hash: schema.as_deref(),
            input_hash: None,
            verdict: &verdict,
            min_confidence_bps: 0,
            prompt_hash: prompt_hash.as_deref(),
            user_message: None,
        };
        let fallback_hash = match &proof {
            ExecutionProof::Receipt(s) => to_hex(&receipt_digest(&s.receipt)),
            ExecutionProof::NearAi(p) => to_hex(&env::sha256_array(p.signed_text.as_bytes())),
        };
        match self.verify_proof(&proof, &exp) {
            Ok((hash, _)) => AttestationCheck { valid: true, receipt_hash: hash, reason: None },
            Err(e) => AttestationCheck { valid: false, receipt_hash: fallback_hash, reason: Some(e.reason().to_string()) },
        }
    }

    /// Parity helper: the digest an enclave must sign for `receipt`.
    pub fn compute_receipt_digest(&self, receipt: ExecutionReceipt) -> String {
        to_hex(&receipt_digest(&receipt))
    }

    /// Parity helper: the marker a NEAR AI request must contain.
    pub fn compute_binding_marker(
        &self,
        subject_kind: String,
        subject_id: U64,
        agent_id: AccountId,
        input_hash: String,
        nonce: String,
        issued_at_ns: U64,
    ) -> String {
        near_ai_binding_marker(&subject_kind, subject_id.0, agent_id.as_str(), &input_hash, &nonce, issued_at_ns.0)
    }

    pub fn get_attestation(&self, receipt_hash: String) -> Option<AttestationRecord> {
        self.attestations.get(&receipt_hash).cloned()
    }

    /// Newest first.
    pub fn list_attestations(&self, limit: Option<u32>) -> Vec<AttestationRecord> {
        let limit = limit.unwrap_or(20).min(crate::MAX_PAGE);
        let len = self.attestation_log.len();
        (0..len)
            .rev()
            .take(limit as usize)
            .filter_map(|i| self.attestation_log.get(i))
            .filter_map(|h| self.attestations.get(h).cloned())
            .collect()
    }

    pub fn list_enclaves(&self) -> Vec<EnclaveRecord> {
        self.enclaves.values().cloned().collect()
    }
}

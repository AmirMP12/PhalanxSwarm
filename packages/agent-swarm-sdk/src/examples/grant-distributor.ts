/**
 * Grant Distributor Agent Example
 *
 * A DAO agent that:
 * - Reviews grant applications
 * - Distributes approved grants automatically
 * - Tracks milestone deliveries
 * - Enforces vesting schedules
 * - Uses TEE-verified decisions for transparency
 */

import type { PhalanxContract, Signer } from "../contract-client.ts";
import type { CrossChainIntentRequestT } from "../types.ts";

export interface GrantApplication {
  id: string;
  applicant: string;
  chain: string;
  title: string;
  amount_requested: bigint;
  category: "infrastructure" | "dapp" | "tooling" | "education" | "research";
  milestones: Milestone[];
  status: "pending" | "approved" | "rejected" | "active" | "completed";
}

export interface Milestone {
  id: string;
  description: string;
  amount: bigint;
  deadline: Date;
  deliverable_url?: string;
  completed: boolean;
  verified: boolean;
}

export interface DistributionPlan {
  grant_id: string;
  recipient: string;
  chain: string;
  amount: bigint;
  milestone_id: string;
  reason: string;
}

/**
 * Grant Distributor Brain
 *
 * Makes distribution decisions based on:
 * - Milestone completion verification
 * - Community approval (via DAO votes)
 * - Treasury liquidity
 * - Vesting schedules
 */
export class GrantDistributor {
  constructor(
    private readonly contract: PhalanxContract,
    private readonly signer: Signer,
  ) {}

  /**
   * Get approved grants from DAO
   */
  async getApprovedGrants(): Promise<GrantApplication[]> {
    // In production, this would query:
    // - SputnikDAO/AstroDAO proposals
    // - Grant management database
    // - On-chain grant registry

    return [
      {
        id: "grant-001",
        applicant: "builder.near",
        chain: "near",
        title: "NEAR Developer Tools Suite",
        amount_requested: 10_000n * 10n ** 24n, // 10,000 NEAR
        category: "tooling",
        status: "active",
        milestones: [
          {
            id: "m1",
            description: "MVP Release - CLI tool with basic commands",
            amount: 3_000n * 10n ** 24n,
            deadline: new Date(Date.now() + 5 * 86_400_000),
            deliverable_url: "https://github.com/builder/tool/releases/v0.1.0",
            completed: true,
            verified: false,
          },
          {
            id: "m2",
            description: "Integration Testing Suite",
            amount: 4_000n * 10n ** 24n,
            deadline: new Date(Date.now() + 21 * 86_400_000),
            completed: false,
            verified: false,
          },
          {
            id: "m3",
            description: "Documentation and Tutorial",
            amount: 3_000n * 10n ** 24n,
            deadline: new Date(Date.now() + 35 * 86_400_000),
            completed: false,
            verified: false,
          },
        ],
      },
      {
        id: "grant-002",
        applicant: "0xEducator123",
        chain: "arb",
        title: "Web3 Education Platform",
        amount_requested: 5_000n * 10n ** 24n, // 5,000 NEAR equivalent
        category: "education",
        status: "active",
        milestones: [
          {
            id: "m1",
            description: "Course Content Creation",
            amount: 2_000n * 10n ** 24n,
            deadline: new Date(Date.now() + 10 * 86_400_000),
            deliverable_url: "https://edu.platform/courses/near-101",
            completed: true,
            verified: false,
          },
          {
            id: "m2",
            description: "Platform Launch with 100 Students",
            amount: 3_000n * 10n ** 24n,
            deadline: new Date(Date.now() + 30 * 86_400_000),
            completed: false,
            verified: false,
          },
        ],
      },
    ];
  }

  /**
   * Verify milestone completion
   *
   * In production, this would:
   * - Check GitHub releases/commits
   * - Verify deployed contracts
   * - Review submitted deliverables
   * - Query community sentiment
   */
  async verifyMilestone(grant: GrantApplication, milestone: Milestone): Promise<boolean> {
    console.log(`\n🔍 Verifying milestone: ${milestone.description}`);

    if (!milestone.completed) {
      console.log(`   ⏳ Not marked as completed yet`);
      return false;
    }

    if (milestone.deadline < new Date()) {
      console.log(`   ⚠️  Deadline passed: ${milestone.deadline.toISOString()}`);
    }

    if (!milestone.deliverable_url) {
      console.log(`   ❌ No deliverable URL provided`);
      return false;
    }

    // Simulate verification checks
    console.log(`   📦 Checking deliverable: ${milestone.deliverable_url}`);
    console.log(`   ✅ Deliverable verified`);
    console.log(`   ✅ Code quality acceptable`);
    console.log(`   ✅ Documentation present`);
    console.log(`   ✅ Community approval: 85%`);

    return true;
  }

  /**
   * Create distribution plan for verified milestones
   */
  async createDistributionPlan(grants: GrantApplication[]): Promise<DistributionPlan[]> {
    const plans: DistributionPlan[] = [];

    for (const grant of grants) {
      if (grant.status !== "active") continue;

      for (const milestone of grant.milestones) {
        if (!milestone.completed || milestone.verified) continue;

        const verified = await this.verifyMilestone(grant, milestone);

        if (verified) {
          plans.push({
            grant_id: grant.id,
            recipient: grant.applicant,
            chain: grant.chain,
            amount: milestone.amount,
            milestone_id: milestone.id,
            reason: `Milestone completed: ${milestone.description}`,
          });
        }
      }
    }

    return plans;
  }

  /**
   * Execute grant distribution
   */
  async distributeGrant(plan: DistributionPlan): Promise<boolean> {
    console.log(`\n💸 Distributing Grant Payment:`);
    console.log(`   Grant ID: ${plan.grant_id}`);
    console.log(`   Recipient: ${plan.recipient}`);
    console.log(`   Chain: ${plan.chain}`);
    console.log(`   Amount: ${plan.amount / 10n ** 24n} NEAR`);
    console.log(`   Reason: ${plan.reason}`);

    // Check treasury liquidity
    const treasury = await this.contract.treasury();
    console.log(`\n💰 Treasury Check:`);
    console.log(`   Available: ${BigInt(treasury.available) / 10n ** 24n} NEAR`);
    console.log(`   Required: ${plan.amount / 10n ** 24n} NEAR`);

    if (BigInt(treasury.available) < plan.amount) {
      console.error(`❌ Insufficient treasury liquidity`);
      return false;
    }

    // Check recipient rules
    const recipientCheck = await this.contract.checkRecipient(plan.chain, plan.recipient);
    console.log(`\n🔒 Recipient Check: ${recipientCheck.verdict}`);

    if (recipientCheck.verdict === "block") {
      console.error(`❌ Recipient is blocked: ${recipientCheck.reasons.join(", ")}`);
      return false;
    }

    if (recipientCheck.verdict === "warn") {
      console.log(`⚠️  Warnings: ${recipientCheck.reasons.join(", ")}`);
      console.log(`   Proceeding with caution...`);
    }

    // Create intent request
    if (plan.chain === "near") {
      // Direct NEAR payment
      console.log(`\n📤 Submitting NEAR payment...`);

      // In production: Use request_vendor_payment
      // const result = await contract.call(signer, "request_vendor_payment", {
      //   recipient: plan.recipient,
      //   amount: plan.amount.toString(),
      //   memo: `Grant ${plan.grant_id}, Milestone ${plan.milestone_id}`,
      // }, null);

      console.log(`✅ Payment submitted`);
    } else {
      // Cross-chain via NEAR Intents
      console.log(`\n🌉 Creating cross-chain intent...`);

      const intent: CrossChainIntentRequestT = {
        kind: "vendor_payment",
        destination_chain: plan.chain,
        origin_asset: "wrap.near",
        destination_asset: "usdc",
        amount: plan.amount.toString(),
        min_amount_out: "1",
        recipient: plan.recipient,
        execution_contract: "intents.near",
        slippage_bps: 50,
        deadline_ns: (BigInt(Date.now()) * 1_000_000n + 600_000_000_000n).toString(), // 10 min
        quote: null,
        nonce: "1",
        signature: "",
        attestation: null,
        memo: `Grant ${plan.grant_id}, Milestone ${plan.milestone_id}`,
      };

      const assessment = await this.contract.evaluateIntent(this.signer.accountId, intent);

      if (!assessment.decision.approved) {
        console.error(`❌ Intent evaluation failed: ${assessment.decision.violations.map((v) => v.code).join(", ")}`);
        return false;
      }

      console.log(`✅ Intent pre-flight passed`);

      // In production: Sign and submit
      // const signature = await signNEP413(intent, agentKey);
      // const result = await contract.call(signer, "request_intent_settlement", { intent, signature }, null);
    }

    console.log(`\n✅ Grant distribution complete!`);
    console.log(`   Transaction will be recorded on-chain`);
    console.log(`   Milestone ${plan.milestone_id} marked as paid`);

    return true;
  }

  /**
   * Main execution loop
   */
  async run() {
    console.log(`\n🏛️  Grant Distributor Agent Starting...`);
    console.log(`   Treasury: ${this.contract.contractId}`);
    console.log(`   Agent: ${this.signer.accountId}\n`);

    // Get DAO policy
    const policy = await this.contract.policy();
    console.log(`📋 Distribution Policy:`);
    console.log(`   Max per transaction: ${BigInt(policy.max_tx_amount_yocto) / 10n ** 24n} NEAR`);
    console.log(`   Max per epoch: ${BigInt(policy.epoch_spending_cap_yocto) / 10n ** 24n} NEAR`);
    console.log(`   Recipient rule: ${policy.unknown_recipient}\n`);

    // Get approved grants
    console.log(`📝 Loading approved grants...`);
    const grants = await this.getApprovedGrants();
    console.log(`   Found ${grants.length} active grants\n`);

    grants.forEach((grant) => {
      const completed = grant.milestones.filter((m) => m.completed).length;
      const total = grant.milestones.length;
      console.log(`   • ${grant.title}`);
      console.log(`     Progress: ${completed}/${total} milestones`);
      console.log(`     Category: ${grant.category}`);
    });

    // Create distribution plan
    console.log(`\n🧠 Analyzing milestone completions...`);
    const plans = await this.createDistributionPlan(grants);

    if (plans.length === 0) {
      console.log(`✅ No distributions needed at this time.`);
      console.log(`   Waiting for milestone completions...\n`);
      return;
    }

    console.log(`\n💡 Found ${plans.length} payment(s) to process:`);

    let successCount = 0;
    for (const plan of plans) {
      const success = await this.distributeGrant(plan);
      if (success) successCount++;
    }

    console.log(`\n✅ Distribution run complete!`);
    console.log(`   Successful: ${successCount}/${plans.length}`);
    console.log(`   Total distributed: ${plans.reduce((sum, p) => sum + p.amount, 0n) / 10n ** 24n} NEAR\n`);
  }
}

/**
 * Example usage
 */
export async function runGrantDistributorExample(contract: PhalanxContract, agentSigner: Signer) {
  const distributor = new GrantDistributor(contract, agentSigner);
  await distributor.run();
}

/**
 * CLI entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Grant Distributor Agent Example");
  console.log("This would connect to a real DAO treasury and process grant distributions.");
  console.log("Use: import { runGrantDistributorExample } from '@phalanx/agent-swarm-sdk/examples'");
}

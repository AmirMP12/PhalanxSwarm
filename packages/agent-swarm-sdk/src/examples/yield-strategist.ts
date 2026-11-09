/**
 * Yield Strategist Agent Example
 *
 * An autonomous DeFi agent that:
 * - Monitors yield opportunities across protocols
 * - Rebalances positions to maximize returns
 * - Executes cross-chain swaps via NEAR Intents
 * - Uses TEE-verified decision making
 * - Operates within DAO-set risk parameters
 */

import type { PhalanxContract, Signer } from "../contract-client.ts";
import type { CrossChainIntentRequestT } from "../types.ts";

export interface YieldOpportunity {
  protocol: string;
  chain: string;
  asset: string;
  apy: number;
  tvl: bigint;
  risk_score: number; // 0-100, lower is safer
}

export interface Position {
  protocol: string;
  chain: string;
  asset: string;
  amount: bigint;
  current_apy: number;
}

export interface RebalanceDecision {
  from: Position;
  to: YieldOpportunity;
  amount: bigint;
  expected_gain_apy: number;
  reason: string;
}

/**
 * Yield Strategist Brain
 *
 * Analyzes opportunities and makes rebalancing decisions based on:
 * - APY differential threshold
 * - Risk limits
 * - Gas cost amortization
 * - Minimum position size
 */
export class YieldStrategist {
  constructor(
    private readonly contract: PhalanxContract,
    private readonly signer: Signer,
  ) {}

  /**
   * Scan for yield opportunities across supported protocols
   */
  async scanOpportunities(): Promise<YieldOpportunity[]> {
    // In production, this would query:
    // - DeFi Llama API
    // - Protocol-specific APIs (Aave, Compound, etc.)
    // - On-chain data via indexers

    return [
      {
        protocol: "Aave V3",
        chain: "arb",
        asset: "USDC",
        apy: 4.2,
        tvl: 100_000_000n * 10n ** 6n, // $100M
        risk_score: 15,
      },
      {
        protocol: "Compound V3",
        chain: "base",
        asset: "USDC",
        apy: 5.8,
        tvl: 50_000_000n * 10n ** 6n, // $50M
        risk_score: 20,
      },
      {
        protocol: "REF Finance",
        chain: "near",
        asset: "USDC.e",
        apy: 12.5,
        tvl: 5_000_000n * 10n ** 6n, // $5M
        risk_score: 45,
      },
    ];
  }

  /**
   * Get current positions from treasury
   */
  async getCurrentPositions(): Promise<Position[]> {
    // In production, query:
    // - Treasury wallet balances
    // - LP positions
    // - Lending positions

    return [
      {
        protocol: "Aave V3",
        chain: "arb",
        asset: "USDC",
        amount: 10_000n * 10n ** 6n, // 10,000 USDC
        current_apy: 4.2,
      },
    ];
  }

  /**
   * Analyze and decide on rebalancing
   */
  async analyzeRebalancing(
    positions: Position[],
    opportunities: YieldOpportunity[],
    minApyGain: number = 2.0, // Minimum 2% APY gain to rebalance
    maxRiskScore: number = 50,
  ): Promise<RebalanceDecision[]> {
    const decisions: RebalanceDecision[] = [];

    for (const position of positions) {
      // Find better opportunities for same asset
      const betterOpps = opportunities.filter(
        (opp) =>
          opp.asset === position.asset && opp.apy > position.current_apy + minApyGain && opp.risk_score <= maxRiskScore && opp.protocol !== position.protocol,
      );

      // Sort by APY (highest first)
      betterOpps.sort((a, b) => b.apy - a.apy);

      if (betterOpps.length > 0) {
        const best = betterOpps[0]!;
        decisions.push({
          from: position,
          to: best,
          amount: position.amount,
          expected_gain_apy: best.apy - position.current_apy,
          reason: `Moving ${position.amount / 10n ** 6n} USDC from ${position.protocol} (${position.current_apy}% APY) to ${best.protocol} (${best.apy}% APY) for ${(best.apy - position.current_apy).toFixed(2)}% gain. Risk score: ${best.risk_score}/100`,
        });
      }
    }

    return decisions;
  }

  /**
   * Execute rebalancing via NEAR Intents
   */
  async executeRebalance(decision: RebalanceDecision): Promise<boolean> {
    console.log(`\n🔄 Executing Rebalance:`);
    console.log(`   From: ${decision.from.protocol} on ${decision.from.chain}`);
    console.log(`   To: ${decision.to.protocol} on ${decision.to.chain}`);
    console.log(`   Amount: ${decision.amount / 10n ** 6n} ${decision.from.asset}`);
    console.log(`   Expected Gain: +${decision.expected_gain_apy.toFixed(2)}% APY`);

    // Step 1: Withdraw from current position
    console.log(`\n1️⃣  Withdrawing from ${decision.from.protocol}...`);

    // Step 2: Cross-chain transfer if needed
    if (decision.from.chain !== decision.to.chain) {
      console.log(`2️⃣  Cross-chain transfer: ${decision.from.chain} → ${decision.to.chain}`);

      const intent: CrossChainIntentRequestT = {
        kind: "liquidity_deployment",
        destination_chain: decision.to.chain,
        origin_asset: "wrap.near",
        destination_asset: "usdc",
        amount: decision.amount.toString(),
        min_amount_out: "1",
        recipient: this.contract.contractId, // Treasury receives on destination
        execution_contract: "intents.near",
        slippage_bps: 50,
        deadline_ns: (BigInt(Date.now()) * 1_000_000n + 300_000_000_000n).toString(), // 5 min
        quote: null,
        nonce: "1",
        signature: "",
        attestation: null,
        memo: `Rebalance: ${decision.from.protocol} → ${decision.to.protocol}`,
      };

      // Check pre-flight
      const assessment = await this.contract.evaluateIntent(this.signer.accountId, intent);

      if (!assessment.decision.approved) {
        console.error(`❌ Pre-flight failed: ${assessment.decision.violations.map((v) => v.code).join(", ")}`);
        return false;
      }

      console.log(`✅ Pre-flight passed`);

      // In production: Sign with agent's key and submit
      // const signature = await signNEP413(intent, agentKey);
      // const result = await contract.call(signer, "request_intent_settlement", { intent, signature }, null);
    }

    // Step 3: Deposit into new position
    console.log(`3️⃣  Depositing into ${decision.to.protocol}...`);

    console.log(`\n✅ Rebalance complete!`);
    console.log(`   New position: ${decision.amount / 10n ** 6n} ${decision.to.asset} at ${decision.to.apy}% APY`);
    console.log(`   Annual gain: $${(((Number(decision.amount) / 1e6) * decision.expected_gain_apy) / 100).toFixed(2)}`);

    return true;
  }

  /**
   * Main execution loop
   */
  async run() {
    console.log(`\n💰 Yield Strategist Agent Starting...`);
    console.log(`   Treasury: ${this.contract.contractId}`);
    console.log(`   Agent: ${this.signer.accountId}\n`);

    // Get policy limits
    const policy = await this.contract.policy();
    console.log(`📋 Policy Limits:`);
    console.log(`   Max per transaction: ${policy.max_tx_amount_yocto} yoctoNEAR`);
    console.log(`   Max per epoch: ${policy.epoch_spending_cap_yocto} yoctoNEAR`);
    console.log(`   Risk tolerance: Medium (max score 50/100)\n`);

    // Scan opportunities
    console.log(`🔍 Scanning yield opportunities...`);
    const opportunities = await this.scanOpportunities();
    opportunities.forEach((opp) => {
      console.log(`   • ${opp.protocol} (${opp.chain}): ${opp.apy}% APY, Risk: ${opp.risk_score}/100`);
    });

    // Get current positions
    console.log(`\n📊 Current Positions:`);
    const positions = await this.getCurrentPositions();
    positions.forEach((pos) => {
      console.log(`   • ${pos.protocol}: ${pos.amount / 10n ** 6n} ${pos.asset} at ${pos.current_apy}% APY`);
    });

    // Analyze rebalancing opportunities
    console.log(`\n🧠 Analyzing rebalancing opportunities...`);
    const decisions = await this.analyzeRebalancing(positions, opportunities);

    if (decisions.length === 0) {
      console.log(`✅ No rebalancing needed. Current positions are optimal.`);
      return;
    }

    console.log(`\n💡 Found ${decisions.length} rebalancing opportunity:`);
    for (const decision of decisions) {
      console.log(`\n${decision.reason}`);

      // Execute rebalance
      await this.executeRebalance(decision);
    }

    console.log(`\n✅ Yield Strategist run complete!\n`);
  }
}

/**
 * Example usage
 */
export async function runYieldStrategistExample(contract: PhalanxContract, agentSigner: Signer) {
  const strategist = new YieldStrategist(contract, agentSigner);
  await strategist.run();
}

/**
 * CLI entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Yield Strategist Agent Example");
  console.log("This would connect to a real deployment and run the agent.");
  console.log("Use: import { runYieldStrategistExample } from '@phalanx/agent-swarm-sdk/examples'");
}

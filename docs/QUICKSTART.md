# PhalanxSwarm Quick Start — Deploy in 10 Minutes

Get your own PhalanxSwarm treasury running on NEAR testnet in just a few commands.

## Prerequisites

- Node.js 20.19+ and pnpm 10
- Rust 1.99.1+ (via rustup)
- NEAR CLI: `npm install -g near-cli`
- Testnet account: https://testnet.mynearwallet.com

## Step 1: Clone and Install (2 minutes)

```bash
git clone https://github.com/AmirMP12/PhalanxSwarm.git
cd PhalanxSwarm
pnpm install
```

## Step 2: Build the Contract (2 minutes)

```bash
pnpm build:contract
```

This compiles `contracts/phalanx-core` to `contracts/phalanx-core/target/wasm32-unknown-unknown/release/phalanx_core.wasm`.

## Step 3: Deploy to Testnet (1 minute)

First, login to NEAR CLI:

```bash
near login
```

Deploy the contract (replace `YOUR_ACCOUNT.testnet` with your account):

```bash
near deploy YOUR_ACCOUNT.testnet contracts/phalanx-core/target/wasm32-unknown-unknown/release/phalanx_core.wasm
```

## Step 4: Initialize the Contract (1 minute)

```bash
near call YOUR_ACCOUNT.testnet new '{
  "owner_id": "YOUR_ACCOUNT.testnet",
  "config": null,
  "policy": null,
  "revenue_splits": null
}' --accountId YOUR_ACCOUNT.testnet
```

This initializes with default configuration and makes your account the owner.

## Step 5: Fund the Treasury (1 minute)

```bash
near call YOUR_ACCOUNT.testnet fund_treasury '{
  "memo": "Initial funding"
}' --accountId YOUR_ACCOUNT.testnet --amount 10
```

This deposits 10 NEAR into the treasury.

## Step 6: Register Your First Agent (2 minutes)

```bash
near call YOUR_ACCOUNT.testnet register_and_spawn_agent '{
  "handle": "sentinel",
  "role": "sentinel",
  "public_key": "ed25519:YOUR_PUBLIC_KEY",
  "reputation": 8000,
  "policy": null
}' --accountId YOUR_ACCOUNT.testnet
```

**Note:** Generate a keypair first:

```bash
near generate-key sentinel.YOUR_ACCOUNT.testnet --networkId testnet
```

The public key will be in `~/.near-credentials/testnet/sentinel.YOUR_ACCOUNT.testnet.json`.

This creates sub-account `sentinel.YOUR_ACCOUNT.testnet` with a scoped FunctionCall key.

## Step 7: Verify It Works (1 minute)

Check the dashboard:

```bash
near view YOUR_ACCOUNT.testnet get_dashboard '{}'
```

You should see:
- Treasury balance: ~10 NEAR
- 1 registered agent (sentinel)
- Contract version: 0.1.0

## Next Steps

### Try the SDK

```bash
cd packages/agent-swarm-sdk
pnpm install
pnpm test
```

### Run the Judge Scenario Locally

```bash
pnpm judge:offline
```

This runs the full 11-step protocol demonstration in an in-process sandbox.

### Deploy the Web App

```bash
cd apps/web
pnpm install
pnpm dev
```

Visit http://localhost:3000 to see the web interface.

### Configure Your Policy

Edit the global policy to set spending limits:

```bash
near call YOUR_ACCOUNT.testnet update_global_policy '{
  "policy": {
    "max_tx_amount": "25000000000000000000000000",
    "max_epoch_amount": "100000000000000000000000000",
    "velocity_window_sec": 3600,
    "max_velocity_requests": 10,
    "unknown_recipient_rule": "quarantine",
    "allowed_recipients": [],
    "allowed_intents_contracts": ["intents.near"],
    "mpc_contract": "v1.signer-prod.testnet",
    "evm_chains": [
      {
        "chain": "eth",
        "max_tx_amount": "1000000000000000000",
        "max_gas_price": "100000000000",
        "allowed_tokens": ["0x0000000000000000000000000000000000000000"]
      }
    ],
    "audit_prompt_hash": "YOUR_PROMPT_HASH",
    "paused": false
  },
  "expected_version": null
}' --accountId YOUR_ACCOUNT.testnet
```

### Register NEAR AI Enclave

If you have NEAR AI access:

```bash
near call YOUR_ACCOUNT.testnet register_enclave '{
  "enclave_id": "YOUR_ENCLAVE_ID",
  "kind": {"near_ai": {"measurement": "YOUR_MEASUREMENT"}},
  "public_key": "YOUR_TEE_PUBLIC_KEY",
  "active": true
}' --accountId YOUR_ACCOUNT.testnet
```

## Common Issues

### "Method not found" Error

Make sure you called `new` to initialize the contract.

### "Insufficient funds" Error

The account needs NEAR for gas. Add more:

```bash
near send YOUR_ACCOUNT.testnet YOUR_ACCOUNT.testnet 5
```

### "Key not found" Error

When registering an agent, make sure the public key is in the correct format: `ed25519:...`

### Contract Already Initialized

If you need to redeploy, delete the old contract first:

```bash
near delete YOUR_ACCOUNT.testnet YOUR_ACCOUNT.testnet
near create-account YOUR_ACCOUNT.testnet --useFaucet
```

Then repeat steps 3-6.

## Production Deployment Checklist

Before deploying to mainnet with real funds:

- [ ] Complete professional security audit
- [ ] Test all functionality on testnet
- [ ] Set up SputnikDAO for governance
- [ ] Configure appropriate spending limits
- [ ] Set up monitoring and alerts
- [ ] Generate reproducible build and verify hash
- [ ] Register TEE enclaves with verified attestations
- [ ] Document disaster recovery procedures
- [ ] Set up multi-sig for contract upgrades
- [ ] Test emergency pause functionality

## Help & Support

- **Documentation:** [README.md](README.md)
- **Full Architecture:** [BUSINESS_MODEL.md](BUSINESS_MODEL.md)
- **Issues:** https://github.com/AmirMP12/PhalanxSwarm/issues
- **Discord:** (Add your Discord link)

## What You Just Built

You now have:

✅ A live PhalanxSwarm treasury on NEAR testnet  
✅ Policy-enforced spending limits  
✅ Agent with scoped FunctionCall key  
✅ On-chain governance foundation  
✅ Ready to integrate with NEAR AI Cloud  
✅ Cross-chain settlement infrastructure  

**Next:** Try integrating your AI agent using the SDK, or explore the web interface to see your deployment in action.

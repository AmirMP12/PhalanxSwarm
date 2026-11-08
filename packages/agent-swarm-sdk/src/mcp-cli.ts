/**
 * `pnpm mcp` — the PhalanxSwarm MCP server over stdio (see mcp.ts).
 *
 *   pnpm --silent mcp               # the recorded testnet deployment (artifacts/testnet-swarm.json), over NEAR RPC
 *   PHALANX_CONTRACT_ID=… pnpm --silent mcp
 *                                   # another deployment; also PHALANX_NETWORK=testnet|mainnet and PHALANX_RPC_URL
 *   pnpm --silent mcp --sim         # an in-process PhalanxSim running artifacts/phalanx_core.wasm with the judge's agents (offline)
 *
 * MCP client configuration (Claude Desktop, Kiro, Cursor; `--silent` keeps pnpm's banner off stdout):
 *   { "mcpServers": { "phalanx-swarm": { "command": "pnpm", "args": ["--silent", "--dir", "/path/to/repo", "mcp"] } } }
 *
 * stdout carries only MCP messages, one JSON-RPC message per line. Logs go to stderr.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { PhalanxViews, RpcTransport } from "./contract-client.ts";
import { PhalanxMcpServer } from "./mcp.ts";
import { loadContractWasm, loadRootEnv, WASM_PATH } from "./node.ts";
import { nearHistorySource } from "./preflight.ts";
import { SwarmRuntime } from "./swarm-orchestrator.ts";

loadRootEnv();
const sim = process.argv.includes("--sim");
const log = (s: string): void => {
  process.stderr.write(`[phalanx-mcp] ${s}\n`);
};

async function makeServer(): Promise<PhalanxMcpServer> {
  if (sim) {
    const rt = await SwarmRuntime.boot({ wasm: loadContractWasm(), intentsMode: "offline" });
    await rt.bootstrap({ attest: false });
    log(`PhalanxSim: ${rt.contract.contractId} with the judge's five agents, offline`);
    return new PhalanxMcpServer({ views: rt.contract, network: "sim", nowNs: () => rt.nowNs() });
  }
  const recordedPath = resolve(WASM_PATH, "../testnet-swarm.json");
  const recorded = existsSync(recordedPath) ? (JSON.parse(readFileSync(recordedPath, "utf8")) as { contract_id?: string; network?: string }) : null;
  const network = (process.env.PHALANX_NETWORK ?? recorded?.network ?? "testnet") as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error("PHALANX_NETWORK must be testnet or mainnet");
  const contractId = process.env.PHALANX_CONTRACT_ID ?? recorded?.contract_id;
  if (!contractId) throw new Error("set PHALANX_CONTRACT_ID (artifacts/testnet-swarm.json is missing), or run with --sim");
  const rpcUrl = process.env.PHALANX_RPC_URL ?? (network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
  log(`${network}: ${contractId} via ${rpcUrl}`);
  return new PhalanxMcpServer({
    views: new PhalanxViews(new RpcTransport(rpcUrl, contractId)),
    network,
    history: nearHistorySource({ network, rpcUrl }),
  });
}

async function main(): Promise<void> {
  const server = await makeServer();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue
      .then(async () => {
        const out = await server.handleLine(line);
        if (out) process.stdout.write(`${out}\n`);
      })
      .catch((err: unknown) => log(`error: ${err instanceof Error ? err.message : String(err)}`));
  });
  // End of input is the client's shutdown signal: answer what is in flight, then exit.
  lines.on("close", () => void queue.then(() => process.exit(0)));
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

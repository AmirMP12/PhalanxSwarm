import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// One .env for the whole monorepo: load the repo-root .env (variables already set in the
// environment win). Next.js itself only reads apps/web/.env*. Skipped on Vercel (VERCEL=1,
// also set by `vercel build`): deployments use the project's Environment Variables only, so a
// local .env can never end up inlined in a deployed bundle.
const rootEnv = resolve(repoRoot, ".env");
if (!process.env.VERCEL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // NEXT_DIST_DIR lets a production build/serve run next to a live `next dev` without both
  // writing into .next (Next 15 shares the directory between dev and build).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  // The SDK ships TypeScript sources; Next compiles them with the app.
  transpilePackages: ["@phalanx/agent-swarm-sdk"],
  // The DCAP verifier is only used by the Node.js attestation route.
  serverExternalPackages: ["@phala/dcap-qvl"],
  // The attestation route reads the saved DCAP evidence at runtime when a fresh check fails.
  outputFileTracingIncludes: { "/api/tee/attest": ["./public/evidence/nearai-attestation.json"] },
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        // The page sends real testnet transactions through the user's wallet, so no other site may
        // frame it (clickjacking). Only frame-ancestors is set: NEAR Connect loads wallet code into
        // iframes of its own, which a script or frame-src policy would have to list one by one.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
      { source: "/phalanx_core.wasm", headers: [{ key: "Content-Type", value: "application/wasm" }] },
    ];
  },
};

export default nextConfig;

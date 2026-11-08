#!/usr/bin/env node
/**
 * Rejects fixed calendar dates and placeholder datasets in runtime source.
 *
 * Historical evidence, event rules, and known-answer/unit-test vectors are intentionally outside
 * this check: their timestamps are facts or signed test inputs and must remain immutable. Runtime
 * code must obtain time from the clock, block context, API response, or injected test clock.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoots = ["apps/web/src", "apps/web/scripts", "packages/agent-swarm-sdk/src", "scripts", "contracts/phalanx-core/src"];
const standaloneSourceFiles = ["apps/web/next.config.ts", "apps/web/postcss.config.mjs"];
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx", ".rs"]);
const excludedNames = new Set(["tests.rs", "check-source-integrity.mjs"]);
/**
 * Some specifications name their revisions by date (MCP: "2026-07-28"). A line that lists such
 * revision ids carries this marker, which exempts it from the date check only.
 */
const REVISION_ID_MARKER = "source-integrity: revision ids";

const checks = [
  {
    name: "fixed calendar date",
    pattern: new RegExp(String.raw`(?<!\d)(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)`, "g"),
  },
  {
    name: "date constructor with a string literal",
    pattern: new RegExp(String.raw`\b(?:Date\.UTC|Date\.parse|new\s+Date)\s*\(\s*["'\x60]`, "g"),
  },
  {
    name: "placeholder dataset identifier",
    pattern: new RegExp(String.raw`\b(?:mock|fake|dummy|placeholder|hardcoded)(?:Data|Rows|Items|Records|Response|Result|State|Users?)\b`, "gi"),
  },
  {
    name: "unfinished source marker",
    pattern: new RegExp(String.raw`\b(?:TODO|FIXME|XXX)\b`, "g"),
  },
];

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (sourceExtensions.has(extname(entry.name)) && !excludedNames.has(entry.name) && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

const failures = [];
const sourceFiles = [
  ...sourceRoots.flatMap((sourceRoot) => filesUnder(resolve(root, sourceRoot))),
  ...standaloneSourceFiles.map((file) => resolve(root, file)),
];
for (const file of sourceFiles) {
  let text = readFileSync(file, "utf8");
  if (extname(file) === ".rs") text = text.split("#[cfg(test)]", 1)[0];
  const lines = text.split(/\r?\n/);
  for (const check of checks) {
    check.pattern.lastIndex = 0;
    for (let match = check.pattern.exec(text); match; match = check.pattern.exec(text)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      if (match[0].length === 0) check.pattern.lastIndex += 1;
      if (check.name === "fixed calendar date" && lines[line - 1]?.includes(REVISION_ID_MARKER)) continue;
      failures.push(`${relative(root, file)}:${line}: ${check.name}: ${lines[line - 1]?.trim() ?? match[0]}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Source integrity check failed:\n" + failures.map((failure) => `  ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Source integrity check passed: runtime source has no fixed calendar dates, placeholder datasets, or unfinished markers.");
}

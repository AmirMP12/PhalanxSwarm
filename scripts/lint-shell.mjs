import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "lint-shell.sh");

if (process.platform === "win32") {
  const checkSc = spawnSync("where.exe", ["shellcheck"], { stdio: "ignore" });
  if (checkSc.status === 0) {
    const run = spawnSync("shellcheck", ["scripts/*.sh"], { stdio: "inherit", shell: true });
    process.exit(run.status ?? 0);
  }
  const checkBash = spawnSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
  if (checkBash.status === 0) {
    const run = spawnSync("bash", [scriptPath], { stdio: "inherit" });
    process.exit(run.status ?? 0);
  }
  console.warn("⚠️  ShellCheck / bash is not available on Windows. Skipping shell linting...");
  process.exit(0);
} else {
  const run = spawnSync("bash", [scriptPath], { stdio: "inherit" });
  process.exit(run.status ?? 0);
}

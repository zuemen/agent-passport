/**
 * Agent Passport on a local chain — no keys, no testnet MON.
 *
 *   npm run local -w demo            anvil + every contract deployed + the live demo API + the app, ready to click
 *   npm run scenario:local -w demo   the same chain, then the whole storyline headless; exits non-zero on a surprise
 *
 * Uses anvil's public development accounts. Writes only to demo/.state-local/ and contracts/deployments/31337.json
 * (both git-ignored), never to the Monad testnet records.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

process.env.DEMO_NETWORK = "local";
const { ANVIL_MNEMONIC, LOCAL_RPC, localChain, localDeploymentFile, repoRoot, stateDir } = await import("./env.js");

const headless = process.argv.includes("--scenario");
const port = new URL(LOCAL_RPC).port;
const children: ChildProcess[] = [];
let anvilErrors = "";
const deployerKey = toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 }).getHdKey().privateKey!);
const childEnv = (extra: Record<string, string> = {}) => {
  // Never hand the testnet deployment settings from .env to the local deploy.
  const { IDENTITY_REGISTRY, REPUTATION_REGISTRY, VLEI_VERIFIER, ...rest } = process.env;
  return { ...rest, DEMO_NETWORK: "local", ...extra };
};

function start(label: string, cmd: string, cwd: string, env = childEnv()): ChildProcess {
  const p = spawn(cmd, {
    cwd,
    env,
    shell: true,
    detached: process.platform !== "win32", // its own process group, so stopAll can end the shell and what it started
    stdio: label === "anvil" ? ["ignore", "ignore", "pipe"] : headless ? "ignore" : ["ignore", "inherit", "inherit"],
  });
  // Keep the tail of anvil's errors, to explain a chain that does not come up.
  p.stderr?.on("data", (b: Buffer) => (anvilErrors = (anvilErrors + b.toString()).slice(-2000)));
  children.push(p);
  return p;
}

function stopAll() {
  for (const p of children) {
    if (p.pid === undefined || p.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {
        p.kill("SIGTERM");
      }
    }
  }
}
process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

function run(label: string, cmd: string, cwd: string, env = childEnv()) {
  const r = spawnSync(cmd, { cwd, env, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${label} failed:\n${(r.stdout ?? "").slice(-1500)}${(r.stderr ?? "").slice(-1500)}`);
  return r.stdout ?? "";
}

async function waitFor(check: () => Promise<unknown>, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      await check();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`${what} did not come up`);
}

try {
  // A fresh chain every time, so the previous run's agent and mandate would not exist on it.
  if (stateDir.endsWith(".state-local")) rmSync(stateDir, { recursive: true, force: true });

  console.log(`▸ anvil on ${LOCAL_RPC} (chain 31337)`);
  const anvil = start("anvil", `anvil --port ${port} --chain-id 31337 --silent`, repoRoot);
  const client = createPublicClient({ chain: localChain, transport: http(LOCAL_RPC, { timeout: 1_000, retryCount: 0 }) });
  await waitFor(async () => {
    if (anvil.exitCode !== null) throw new Error(`anvil exited (${anvil.exitCode}): ${anvilErrors.trim()}`);
    return client.getChainId();
  }, "anvil").catch((e: Error) => {
    throw new Error(`${e.message}${anvilErrors ? `
${anvilErrors.trim()}` : ""}`);
  });

  console.log("▸ deploying the contracts (contracts/script/Deploy.s.sol)");
  const contracts = join(repoRoot, "contracts");
  run("deploy", `forge script script/Deploy.s.sol --rpc-url ${LOCAL_RPC} --broadcast`, contracts, childEnv({ DEPLOYER_PRIVATE_KEY: deployerKey }));
  const d = JSON.parse(readFileSync(localDeploymentFile, "utf8")) as Record<string, string | number>;

  // The look-alike DEX of the prompt-injection story: the same contract, but not an allowed payee in any mandate.
  const created = run(
    "look-alike DEX",
    `forge create src/demo/PassportDex.sol:PassportDex --rpc-url ${LOCAL_RPC} --private-key ${deployerKey} --broadcast ` +
      `--constructor-args ${d.passportGate} ${d.demoUsd} ${d.demoWmon} 500000000000000000000000000000 ${d.groundedFeedback}`,
    contracts,
  );
  d.lookalikeDex = created.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)![1];
  writeFileSync(localDeploymentFile, JSON.stringify(d, null, 2));
  console.log(`  PassportGate ${d.passportGate} · look-alike DEX ${d.lookalikeDex}`);

  const demo = join(repoRoot, "demo");
  if (headless) {
    console.log("▸ running the storyline (scenario/run.ts)\n");
    const r = spawnSync("npx tsx scenario/run.ts", { cwd: demo, env: childEnv(), shell: true, stdio: "inherit" });
    process.exitCode = r.status ?? 1;
  } else {
    console.log("▸ starting the live demo API and the app");
    start("api", "npx tsx scenario/server.ts", demo);
    await waitFor(() => fetch("http://127.0.0.1:18790/api/state"), "demo API");
    const setup = (await (await fetch("http://127.0.0.1:18790/api/step/setup", { method: "POST" })).json()) as { error?: string };
    if (setup.error) throw new Error(`agent setup failed: ${setup.error}`);
    start(
      "app",
      "npx vite",
      demo,
      childEnv({ VITE_DEMO_NETWORK: "local", VITE_LOCAL_RPC: LOCAL_RPC, VITE_LOCAL_DEPLOYMENT: JSON.stringify(d) }),
    );
    console.log("\n  Open http://localhost:15173 — the chip says “Live · local chain”. Owner → Sign & anchor, then the Agent actions.");
    console.log("  Ctrl+C stops anvil, the API and the app.\n");
    await new Promise(() => {});
  }
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  if (headless || process.exitCode) stopAll();
  if (!existsSync(localDeploymentFile)) console.error("(no local deployment was written)");
}

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, type Account, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, monadTestnet } from "@agent-passport/sdk";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Minimal .env reader (no dependency): KEY=value lines, # comments. */
function loadEnv(): Record<string, string> {
  const file = join(repoRoot, ".env");
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const env = { ...loadEnv(), ...process.env } as Record<string, string | undefined>;

// ------------------------------------------------------------------ network
// Monad testnet by default. DEMO_NETWORK=local drives a local anvil chain instead (npm run local / scenario:local):
// no keys, no MON, and nothing it writes touches the testnet records.

export const isLocal = env.DEMO_NETWORK === "local";
export const LOCAL_RPC = env.LOCAL_RPC_URL || "http://127.0.0.1:18549";
/** anvil's public development mnemonic: account 0 deploys (and is the vLEI verifier), 1 is the owner, 2 the agent. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const localChain = defineChain({
  id: 31337,
  name: "Local anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC] } },
});
export const chain = isLocal ? localChain : monadTestnet;
export const CHAIN_ID = chain.id;
export const EXPLORER = isLocal ? "" : "https://testnet.monadscan.com";
export const localDeploymentFile = join(repoRoot, "contracts", "deployments", "31337.json");
/** Contract addresses on the selected network (same names as contracts/deployments/<chainId>.json). */
export const deployment: typeof MONAD_TESTNET = !isLocal
  ? MONAD_TESTNET
  : existsSync(localDeploymentFile)
    ? (JSON.parse(readFileSync(localDeploymentFile, "utf8")) as typeof MONAD_TESTNET)
    : ({} as typeof MONAD_TESTNET); // not deployed yet: npm run local deploys, then starts the scripts that use it
/** Where the scenario keeps its agent and mandate, its run logs, and the credentials it hands the MCP server. */
export const stateDir = join(repoRoot, "demo", isLocal ? ".state-local" : ".state");
export const runsDir = isLocal ? join(stateDir, "runs") : join(repoRoot, "demo", "public", "runs");
export const credentialsDir = isLocal ? join(stateDir, "credentials") : join(repoRoot, "mcp-server", "credentials");

/** The MCP server's credential for the scenario's agent (demo/.state/agent.json), else the newest one. */
export function mcpCredentialFile(): string | undefined {
  const dir = join(repoRoot, "mcp-server", "credentials");
  if (!existsSync(dir)) return undefined;
  const state = join(repoRoot, "demo", ".state", "agent.json");
  if (existsSync(state)) {
    const own = join(dir, `agent-${JSON.parse(readFileSync(state, "utf8")).agentId}.json`);
    if (existsSync(own)) return own;
  }
  const files = readdirSync(dir).filter((f) => /^agent-\d+\.json$/.test(f)).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function key(name: string): Hex {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v as Hex;
}

export function actors() {
  const transport = http(isLocal ? LOCAL_RPC : env.MONAD_TESTNET_RPC_URL || undefined);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 100 });
  const wallet = (account: Account) => createWalletClient({ chain, transport, account });
  const local = (i: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
  return {
    publicClient,
    owner: wallet(isLocal ? local(1) : privateKeyToAccount(key("DEMO_OWNER_KEY"))),
    agent: wallet(isLocal ? local(2) : privateKeyToAccount(key("DEMO_AGENT_KEY"))),
    /** The registered vLEI verifier service key (the deployer). */
    vleiVerifier: wallet(isLocal ? local(0) : privateKeyToAccount(key("DEPLOYER_PRIVATE_KEY"))),
    mcpPublicUrl: env.MCP_PUBLIC_URL,
  };
}

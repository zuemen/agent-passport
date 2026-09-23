import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "@agent-passport/sdk";

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

const env = { ...loadEnv(), ...process.env } as Record<string, string | undefined>;

function key(name: string): Hex {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v as Hex;
}

export function actors() {
  const transport = http(env.MONAD_TESTNET_RPC_URL || undefined);
  const publicClient = createPublicClient({ chain: monadTestnet, transport, pollingInterval: 100 });
  const wallet = (pk: Hex) => createWalletClient({ chain: monadTestnet, transport, account: privateKeyToAccount(pk) });
  return {
    publicClient,
    owner: wallet(key("DEMO_OWNER_KEY")),
    agent: wallet(key("DEMO_AGENT_KEY")),
    /** The registered vLEI verifier service key (the deployer on testnet). */
    vleiVerifier: wallet(key("DEPLOYER_PRIVATE_KEY")),
    mcpPublicUrl: env.MCP_PUBLIC_URL,
  };
}

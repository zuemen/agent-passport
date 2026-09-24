import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { MONAD_TESTNET, buildIntent, chainNow } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("deployments and time", () => {
  it("MONAD_TESTNET matches contracts/deployments/10143.json", () => {
    const recorded = JSON.parse(readFileSync(join(here, "..", "..", "contracts", "deployments", "10143.json"), "utf8")) as Record<string, string>;
    for (const [name, address] of Object.entries(MONAD_TESTNET)) {
      expect(recorded[name]?.toLowerCase(), name).toBe(address.toLowerCase());
    }
  });

  it("intent deadlines follow the chain's clock, not the local one", async () => {
    const chainTime = 1_790_219_142n; // a Monad testnet timestamp; the local clock may be hours off
    const client = { getBlock: async () => ({ timestamp: chainTime }) } as unknown as PublicClient;
    const now = await chainNow(client);
    const base = { credentialId: `0x${"11".repeat(32)}`, scope: "dex.swap", asset: MONAD_TESTNET.demoUsd, amount: 1n, relyingParty: MONAD_TESTNET.passportDex } as const;
    expect(buildIntent({ ...base, now }).deadline).toBe(chainTime + 120n);
    expect(buildIntent({ ...base, now, ttlSeconds: 30 }).deadline).toBe(chainTime + 30n);
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeErrorResult, parseAbi, type PublicClient } from "viem";
import { MONAD_TESTNET, buildIntent, chainNow, decodeRevertData, passportGateAbi } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientAt = (timestamp: bigint) => ({ getBlock: async () => ({ timestamp }) }) as unknown as PublicClient;

describe("deployments, time and revert reasons", () => {
  it("MONAD_TESTNET matches contracts/deployments/10143.json", () => {
    const recorded = JSON.parse(readFileSync(join(here, "..", "..", "contracts", "deployments", "10143.json"), "utf8")) as Record<string, string>;
    for (const [name, address] of Object.entries(MONAD_TESTNET)) {
      expect(recorded[name]?.toLowerCase(), name).toBe(address.toLowerCase());
    }
  });

  it("intent deadlines never trail the chain's clock", async () => {
    const local = BigInt(Math.floor(Date.now() / 1000));
    const base = { credentialId: `0x${"11".repeat(32)}`, scope: "dex.swap", asset: MONAD_TESTNET.demoUsd, amount: 1n, relyingParty: MONAD_TESTNET.passportDex } as const;
    // The PC clock lags the chain by hours (as seen on the demo machine): the chain's time wins.
    const ahead = local + 19_542n;
    expect(buildIntent({ ...base, now: await chainNow(clientAt(ahead)) }).deadline).toBe(ahead + 120n);
    // An idle dev chain's latest block is old: the local clock wins.
    const stale = await chainNow(clientAt(1_000n));
    expect(stale >= local).toBe(true);
    expect(buildIntent({ ...base, now: stale, ttlSeconds: 30 }).deadline).toBe(stale + 30n);
  });

  it("revert data decodes to the gate's reason, other known errors, or the selector", () => {
    const notAuthorized = encodeErrorResult({ abi: passportGateAbi, errorName: "NotAuthorized", args: [11] });
    expect(decodeRevertData(notAuthorized)).toBe("PayeeNotAllowed");
    expect(decodeRevertData(encodeErrorResult({ abi: passportGateAbi, errorName: "IntentExpired" }))).toBe("IntentExpired");
    const erc20 = parseAbi(["error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)"]);
    const allowance = encodeErrorResult({ abi: erc20, errorName: "ERC20InsufficientAllowance", args: [MONAD_TESTNET.passportGate, 0n, 5n] });
    expect(decodeRevertData(allowance)).toMatch(/^ERC20InsufficientAllowance\(0x[0-9a-fA-F]{40}, 0, 5\)$/);
    const message = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["paused"] });
    expect(decodeRevertData(message)).toBe("paused");
    expect(decodeRevertData("0x")).toBe("reverted without data");
    expect(decodeRevertData("0xdeadbeef")).toBe("unknown error 0xdeadbeef");
  });
});

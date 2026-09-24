import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { createPresentation, issueCredential, listClaims, verifyPresentation, type AuthorizationInput, type Presentation } from "../src/index.js";

const owner = privateKeyToAccount(generatePrivateKey());
const usd = "0x3d3da601b45596FfC7aeB1B9346646e18DB151A8" as Address;
const dex = "0xEaa7574EBFaa724e0935476b4d4041B5Cf186DaC" as Address;
const input: AuthorizationInput = {
  chainId: 10143,
  identityRegistry: "0x5Df260dec1Ba15368f7fBe338D01a4C764CEAA51",
  statusRegistry: "0xD1bC9758F76b6Ea18fbEE824a8Fe8A99c5fcC451",
  agentId: 7n,
  issuer: owner.address,
  scopes: ["dex.swap", "commerce.pay"],
  limits: [{ asset: usd, maxPerTx: 100_000_000n, dailyLimit: 250_000_000n, symbol: "apUSD" }],
  payees: [dex],
  validFrom: 1_790_000_000n,
  validUntil: 1_792_592_000n,
  text: { purpose: "Treasury rebalancing", ownerName: "Example Treasury Ltd" },
};

// Deterministic choices without a property-testing dependency: a 32-bit linear congruential generator.
let seed = 0x5eed;
const rand = (n: number) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
/** Change one hex digit of a 0x-prefixed value. */
const flip = (h: Hex): Hex => {
  const i = 2 + rand(h.length - 2);
  return `${h.slice(0, i)}${h[i] === "0" ? "1" : "0"}${h.slice(i + 1)}` as Hex;
};

describe("tampering with a presentation", () => {
  it("any single changed salt, key, value or proof element fails verification (200 random cases)", async () => {
    const held = await issueCredential(input, owner);
    const untouched = createPresentation(held, listClaims(held).map((c) => c.name));
    expect((await verifyPresentation(untouched)).valid).toBe(true);

    const fields = ["salt", "key", "value", "proof"] as const;
    for (let k = 0; k < 200; k++) {
      const p: Presentation = structuredClone(untouched);
      const d = p.disclosures[rand(p.disclosures.length)];
      const field = fields[rand(fields.length)];
      if (field === "proof") {
        const j = rand(d.proof.length);
        d.proof[j] = flip(d.proof[j]);
      } else {
        d[field] = flip(d[field]);
      }
      const r = await verifyPresentation(p);
      expect(r.valid, `case ${k}: ${d.name}.${field}`).toBe(false);
    }
  });
});

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

// Deterministic positions without a property-testing dependency: mulberry32, whose every output bit is mixed
// (a plain LCG's low bits cycle with a short period and would pick the same field every time).
let seed = 0x5eed;
const rand = (n: number) => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * n);
};
/** Change one hex digit of a 0x-prefixed value. */
const flip = (h: Hex): Hex => {
  const i = 2 + rand(h.length - 2);
  return `${h.slice(0, i)}${h[i] === "0" ? "1" : "0"}${h.slice(i + 1)}` as Hex;
};

describe("tampering with a presentation", () => {
  it("a changed hex digit in any salt, key, value or proof element of any disclosure fails verification", async () => {
    const held = await issueCredential(input, owner);
    const untouched = createPresentation(held, listClaims(held).map((c) => c.name));
    expect((await verifyPresentation(untouched)).valid).toBe(true);

    // Every disclosure × every field, several random digits each: at least 200 cases, no field left out.
    const fields = ["salt", "key", "value", "proof"] as const;
    const tested = { salt: 0, key: 0, value: 0, proof: 0 };
    const perPair = Math.ceil(200 / (untouched.disclosures.length * fields.length));
    for (let i = 0; i < untouched.disclosures.length; i++) {
      for (const field of fields) {
        for (let k = 0; k < perPair; k++) {
          const p: Presentation = structuredClone(untouched);
          const d = p.disclosures[i];
          if (field === "proof") {
            const j = rand(d.proof.length);
            d.proof[j] = flip(d.proof[j]);
          } else {
            d[field] = flip(d[field]);
          }
          const r = await verifyPresentation(p);
          expect(r.valid, `${d.name}.${field} #${k}`).toBe(false);
          tested[field]++;
        }
      }
    }
    for (const field of fields) expect(tested[field], field).toBeGreaterThanOrEqual(50);
    expect(tested.salt + tested.key + tested.value + tested.proof).toBeGreaterThanOrEqual(200);
  });
});

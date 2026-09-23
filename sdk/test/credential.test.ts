import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import {
  KEY_SCOPE,
  createPresentation,
  dailyLimitKey,
  deserializeCredential,
  issueCredential,
  leaf,
  listClaims,
  maxPerTxKey,
  payeeKey,
  serializeCredential,
  toGatePresentation,
  verifyPresentation,
  type AuthorizationInput,
} from "../src/index.js";

// Reference values computed with `cast` from the Solidity encoding (see PassportClaims.sol).
const A = "0x0000000000000000000000000000000000001234" as Address;

describe("claim encoding matches the contracts", () => {
  it("keys", () => {
    expect(KEY_SCOPE).toBe("0x1d58932f5263908f307b49c5c2bebdd987d288544cd40a77e6bb9b1cdeacda05");
    expect(maxPerTxKey(A)).toBe("0xd05d77fb4c4aea6411b248bb2b2f34fa8761b9d906a15941ce33cde6b668b7b4");
    expect(dailyLimitKey(A)).toBe("0x603ebb72826b68965b844a98db3a00a10f41d8f75ba4f83ec554d7f7d02e1eb6");
    expect(payeeKey(A)).toBe("0x0cd5705b3ed3dea5c4de399b5c79dd382958b56bd608b7c9088670284de4912d");
  });

  it("leaf", () => {
    const b = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
    expect(leaf(b(1), b(2), b(3))).toBe("0x6bf4e61b5cdb00b5d13973040b7e7c9690fc0e3e3509eabf38ee45a4fe1a3c0a");
  });
});

const owner = privateKeyToAccount(generatePrivateKey());
const usd = "0x3d3da601b45596FfC7aeB1B9346646e18DB151A8" as Address;
const dex = "0xEaa7574EBFaa724e0935476b4d4041B5Cf186DaC" as Address;

function input(): AuthorizationInput {
  return {
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
}

describe("issue / present / verify (offline)", () => {
  it("round-trips and reveals only what was selected", async () => {
    const held = await issueCredential(input(), owner);
    expect(listClaims(held)).toHaveLength(7);

    const p = createPresentation(held, ["scope:dex.swap", `maxPerTx:${usd.toLowerCase()}`]);
    const r = await verifyPresentation(p);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.revealed).toEqual({ "scope:dex.swap": "dex.swap", [`maxPerTx:${usd.toLowerCase()}`]: "100000000" });
    expect(JSON.stringify(p)).not.toContain("Example Treasury Ltd");
    expect(r.issuer).toBe(owner.address);
  });

  it("the gate presentation carries exactly scope, per-tx, daily and payee", async () => {
    const held = await issueCredential(input(), owner);
    const g = toGatePresentation(held, { scope: "dex.swap", asset: usd, relyingParty: dex });
    expect(g.credentialId).toBe(held.credentialId);
    expect(g.maxPerTx.key).toBe(maxPerTxKey(usd));
    expect(g.payee.key).toBe(payeeKey(dex));
    expect(() => toGatePresentation(held, { scope: "bridge.withdraw", asset: usd, relyingParty: dex })).toThrow();
  });

  it("rejects a disclosure whose display value was changed", async () => {
    const held = await issueCredential(input(), owner);
    const p = createPresentation(held, [`maxPerTx:${usd.toLowerCase()}`]);
    p.disclosures[0].display = "999999999999";
    const r = await verifyPresentation(p);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/does not match/);
  });

  it("rejects a claim lifted from another credential", async () => {
    const a = await issueCredential(input(), owner);
    const b = await issueCredential({ ...input(), limits: [{ asset: usd, maxPerTx: 10n ** 18n, dailyLimit: 10n ** 18n }] }, owner);
    const p = createPresentation(a, ["scope:dex.swap"]);
    p.disclosures.push(createPresentation(b, [`maxPerTx:${usd.toLowerCase()}`]).disclosures[0]);
    const r = await verifyPresentation(p);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/not part of this credential/);
  });

  it("rejects a VC not signed by its stated issuer", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const held = await issueCredential(input(), other); // issuer field says `owner`
    const r = await verifyPresentation(createPresentation(held, []));
    expect(r.errors).toContain("issuer signature invalid");
  });

  it("rejects duplicate claims at issuance", async () => {
    await expect(issueCredential({ ...input(), scopes: ["dex.swap", "dex.swap"] }, owner)).rejects.toThrow(/duplicate/);
  });

  it("serialises with bigints intact", async () => {
    const held = await issueCredential(input(), owner);
    const back = deserializeCredential(serializeCredential(held));
    expect(back.authorization.agentId).toBe(7n);
    expect(back).toEqual(held);
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { Signer, ready, type SignifyClient } from "signify-ts";
import { SCHEMA } from "../src/keri.js";
import { bindingStatement, checkOwner } from "../src/verifyOwner.js";

/** Chain-walking logic against fixtures shaped like KERIA's /credentials/{said} response. */
const ROOT = "EGleifTestRoot0000000000000000000000000000000";
const QVI = "EQviTest00000000000000000000000000000000000000";
const LE = "ELegalEntityTest000000000000000000000000000000";
const LEI = "APTESTEXAMPLETREA002";
let signer: Signer;
let HOLDER: string;

const issued = { et: "iss", s: "0" };
function chain(o: { root?: string; authAid?: string; leLei?: string; oorStatus?: object } = {}) {
  const qvi = { sad: { d: "Dqvi", s: SCHEMA.QVI, i: o.root ?? ROOT, a: { i: QVI, LEI: "APTESTQVI00000000001" } }, status: issued };
  const le = { sad: { d: "Dle", s: SCHEMA.LE, i: QVI, a: { i: LE, LEI: o.leLei ?? LEI }, e: { qvi: { n: "Dqvi" } } }, status: issued, chains: [qvi] };
  const auth = {
    sad: { d: "Dauth", s: SCHEMA.OOR_AUTH, i: LE, a: { i: QVI, AID: o.authAid ?? HOLDER, LEI }, e: { le: { n: "Dle" } } },
    status: issued,
    chains: [le],
  };
  return {
    sad: { d: "Door", s: SCHEMA.OOR, i: QVI, a: { i: HOLDER, LEI, officialRole: "Treasury Officer" }, e: { auth: { n: "Dauth" } } },
    status: o.oorStatus ?? issued,
    chains: [auth],
  };
}
function client(cred: object, key = signer.verfer.qb64): SignifyClient {
  return { credentials: () => ({ get: async () => cred }), keyStates: () => ({ get: async () => [{ k: [key] }] }) } as never;
}
const statement = () =>
  bindingStatement({ chainId: 10143, statusRegistry: "0xreg", credentialId: "0xabc", issuer: "0xowner", lei: LEI });
const sign = (s: string) => signer.sign(new TextEncoder().encode(s)).qb64;

beforeAll(async () => {
  await ready();
  signer = new Signer({ transferable: true });
  HOLDER = signer.verfer.qb64;
});

describe("vLEI owner check", () => {
  it("accepts a valid chain and binding signature", async () => {
    const r = await checkOwner(client(chain()), { oorSaid: "Door", trustedRoot: ROOT, statement: statement(), signature: sign(statement()) });
    expect(r).toMatchObject({ ok: true, lei: LEI, officialRole: "Treasury Officer" });
  });

  it("rejects a revoked role credential", async () => {
    const r = await checkOwner(client(chain({ oorStatus: { et: "rev", s: "1" } })), { oorSaid: "Door", trustedRoot: ROOT, statement: statement(), signature: sign(statement()) });
    expect(r.failures.join()).toMatch(/OOR credential is rev/);
  });

  it("rejects a chain from an untrusted root", async () => {
    const r = await checkOwner(client(chain({ root: "EOtherRoot" })), { oorSaid: "Door", trustedRoot: ROOT, statement: statement(), signature: sign(statement()) });
    expect(r.failures).toContain("QVI vLEI not issued by the trusted GLEIF root");
  });

  it("rejects an authorization for someone else", async () => {
    const r = await checkOwner(client(chain({ authAid: "ESomeoneElse" })), { oorSaid: "Door", trustedRoot: ROOT, statement: statement(), signature: sign(statement()) });
    expect(r.failures).toContain("OOR AUTH names a different person");
  });

  it("rejects an LEI mismatch in the chain", async () => {
    const r = await checkOwner(client(chain({ leLei: "APTESTOTHERENTITY003" })), { oorSaid: "Door", trustedRoot: ROOT, statement: statement(), signature: sign(statement()) });
    expect(r.failures).toContain("Legal Entity vLEI has a different LEI");
  });

  it("rejects a signature over a different statement or by a different key", async () => {
    const other = statement().replace("0xabc", "0xdef");
    const r1 = await checkOwner(client(chain()), { oorSaid: "Door", trustedRoot: ROOT, statement: other, signature: sign(statement()) });
    expect(r1.failures).toContain("binding signature invalid");
    const r2 = await checkOwner(client(chain(), new Signer({ transferable: true }).verfer.qb64), {
      oorSaid: "Door",
      trustedRoot: ROOT,
      statement: statement(),
      signature: sign(statement()),
    });
    expect(r2.failures).toContain("binding signature invalid");
  });
});

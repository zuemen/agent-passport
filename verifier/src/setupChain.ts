import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Saider } from "signify-ts";
import {
  SCHEMA,
  VLEI_SERVER,
  connect,
  edge,
  getOrCreateAid,
  getOrCreateRegistry,
  issueAndDeliver,
  resolveOobi,
} from "./keri.js";

/**
 * npm run chain -w verifier — build a TEST vLEI chain on the local KERIA stack (docs/VLEI_SETUP.md):
 *
 *   test GLEIF root ─QVI─▶ test QVI ─LE─▶ Example Treasury Ltd ─OOR AUTH─▶ QVI ─OOR─▶ treasury officer
 *
 * Fictional data only: no real LEI, no real company, no real person. Passcodes and SAIDs are kept in
 * verifier/.state/chain.json (git-ignored) so the chain is reused across runs.
 */
const stateFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".state", "chain.json");
mkdirSync(dirname(stateFile), { recursive: true });
const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { passcodes: {} };

// Fictional, clearly-test identifiers (20 chars: 18 alphanumerics + 2 digits).
const QVI_LEI = "APTESTQVI00000000001";
const LE_LEI = "APTESTEXAMPLETREA002";
const OFFICER = { personLegalName: "Alex Example", officialRole: "Treasury Officer" };

// Rules text the vLEI schemas require (public GLEIF ecosystem governance framework wording).
const RULES = Saider.saidify({
  d: "",
  usageDisclaimer: {
    l: "Usage of a valid, unexpired, and non-revoked vLEI Credential, as defined in the associated Ecosystem Governance Framework, does not assert that the Legal Entity is trustworthy, honest, reputable in its business dealings, safe to do business with, or compliant with any laws or that an implied or expressly intended purpose will be fulfilled.",
  },
  issuanceDisclaimer: {
    l: "All information in a valid, unexpired, and non-revoked vLEI Credential, as defined in the associated Ecosystem Governance Framework, is accurate as of the date the validation process was complete. The vLEI Credential has been issued to the legal entity or person named in the vLEI Credential as the subject; and the qualified vLEI Issuer exercised reasonable care to perform the validation process set forth in the vLEI Ecosystem Governance Framework.",
  },
})[1];

const parties = ["gleif", "qvi", "le", "role", "verifier"] as const;
const c: Record<string, Awaited<ReturnType<typeof connect>>> = {};
for (const p of parties) c[p] = await connect(saved.passcodes[p]);
// Persist passcodes immediately, so a failed run resumes with the same identities.
writeFileSync(stateFile, JSON.stringify({ ...saved, passcodes: Object.fromEntries(parties.map((p) => [p, c[p].passcode])) }, null, 2));
const aid = Object.fromEntries(await Promise.all(parties.map(async (p) => [p, await getOrCreateAid(c[p].client, p)])));
console.log("AIDs:", Object.fromEntries(parties.map((p) => [p, aid[p].prefix])));

// Everyone knows everyone (OOBIs) and the vLEI schemas.
await Promise.all(
  parties.flatMap((p) => parties.filter((q) => q !== p).map((q) => resolveOobi(c[p].client, aid[q].oobi, q))),
);
await Promise.all(
  parties.flatMap((p) => Object.values(SCHEMA).map((s) => resolveOobi(c[p].client, `${VLEI_SERVER}/oobi/${s}`))),
);

const [gleifReg, qviReg, leReg] = await Promise.all([
  getOrCreateRegistry(c.gleif.client, aid.gleif, "gleif-registry"),
  getOrCreateRegistry(c.qvi.client, aid.qvi, "qvi-registry"),
  getOrCreateRegistry(c.le.client, aid.le, "le-registry"),
]);
const P = (p: string) => ({ client: c[p].client, aid: aid[p] });

const qviCred = await issueAndDeliver(P("gleif"), P("qvi"), gleifReg, SCHEMA.QVI, { LEI: QVI_LEI });
console.log("QVI credential", qviCred.sad.d);
const leCred = await issueAndDeliver(P("qvi"), P("le"), qviReg, SCHEMA.LE, { LEI: LE_LEI }, { rules: RULES, source: edge("qvi", qviCred) });
console.log("LE credential (Example Treasury Ltd)", leCred.sad.d);
const authCred = await issueAndDeliver(
  P("le"),
  P("qvi"),
  leReg,
  SCHEMA.OOR_AUTH,
  { AID: aid.role.prefix, LEI: LE_LEI, ...OFFICER },
  { rules: RULES, source: edge("le", leCred) },
);
console.log("OOR AUTH credential", authCred.sad.d);
const oorCred = await issueAndDeliver(
  P("qvi"),
  P("role"),
  qviReg,
  SCHEMA.OOR,
  { LEI: LE_LEI, ...OFFICER },
  { rules: RULES, source: edge("auth", authCred, "I2I") },
);
console.log("OOR credential (treasury officer)", oorCred.sad.d);

writeFileSync(
  stateFile,
  JSON.stringify(
    {
      passcodes: Object.fromEntries(parties.map((p) => [p, c[p].passcode])),
      aids: Object.fromEntries(parties.map((p) => [p, aid[p].prefix])),
      trustedRoot: aid.gleif.prefix,
      lei: LE_LEI,
      credentials: { qvi: qviCred.sad.d, le: leCred.sad.d, oorAuth: authCred.sad.d, oor: oorCred.sad.d },
    },
    null,
    2,
  ),
);
console.log("chain ready →", stateFile);

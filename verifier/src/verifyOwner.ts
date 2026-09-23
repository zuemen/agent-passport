import { Cigar, Verfer, type SignifyClient } from "signify-ts";
import { SCHEMA } from "./keri.js";

/**
 * Checks that a GLEIF vLEI Official Organizational Role (OOR) credential is valid and chains to the
 * trusted root, and that its holder signed a statement binding a specific Agent Passport credential:
 *
 *   OOR (issuee = holder) ─auth▶ OOR AUTH (LE → QVI, AID = holder) ─le▶ LE vLEI ─qvi▶ QVI vLEI (issued by root)
 *
 * KERIA already verified every signature and anchor when the verifier admitted the presentation; this
 * adds the vLEI semantics a relying party cares about.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cred = any;

export interface OwnerCheck {
  ok: boolean;
  failures: string[];
  lei?: string;
  officialRole?: string;
  holder?: string;
  oorSaid?: string;
}

/** The statement the role holder signs: "this Agent Passport credential is issued on behalf of my entity". */
export function bindingStatement(b: { chainId: number; statusRegistry: string; credentialId: string; issuer: string; lei: string }) {
  return JSON.stringify({ type: "AgentPassportOwnerBinding/v1", ...b });
}

function issued(c: Cred): boolean {
  const st = c.status;
  return !st || (st.et === "iss" && st.s === "0") || st.et === "bis";
}

function child(parent: Cred, label: string, schema: string): Cred | undefined {
  const said = parent.sad?.e?.[label]?.n;
  return (parent.chains as Cred[] | undefined)?.find((c) => c.sad?.d === said && c.sad?.s === schema);
}

export async function checkOwner(
  verifier: SignifyClient,
  args: { oorSaid: string; trustedRoot: string; statement: string; signature: string },
): Promise<OwnerCheck> {
  const failures: string[] = [];
  const fail = (m: string) => void failures.push(m);

  const oor: Cred = await verifier.credentials().get(args.oorSaid);
  const holder: string = oor.sad.a.i;
  const lei: string = oor.sad.a.LEI;
  if (oor.sad.s !== SCHEMA.OOR) fail("not an OOR credential");
  if (!issued(oor)) fail(`OOR credential is ${oor.status?.et ?? "not issued"}`);

  const auth = child(oor, "auth", SCHEMA.OOR_AUTH);
  if (!auth) fail("missing OOR AUTH in chain");
  else {
    if (auth.sad.a.AID !== holder) fail("OOR AUTH names a different person");
    if (auth.sad.a.LEI !== lei) fail("OOR AUTH is for a different LEI");
    if (auth.sad.a.i !== oor.sad.i) fail("OOR not issued by the QVI the entity authorised");
    if (!issued(auth)) fail("OOR AUTH revoked");
  }

  const le = auth && child(auth, "le", SCHEMA.LE);
  if (!le) fail("missing Legal Entity vLEI in chain");
  else {
    if (le.sad.a.LEI !== lei) fail("Legal Entity vLEI has a different LEI");
    if (le.sad.a.i !== auth!.sad.i) fail("OOR AUTH not issued by the legal entity");
    if (!issued(le)) fail("Legal Entity vLEI revoked");
  }

  const qvi = le && child(le, "qvi", SCHEMA.QVI);
  if (!qvi) fail("missing QVI vLEI in chain");
  else {
    if (qvi.sad.a.i !== le!.sad.i) fail("LE vLEI not issued by the QVI");
    if (qvi.sad.i !== args.trustedRoot) fail("QVI vLEI not issued by the trusted GLEIF root");
    if (!issued(qvi)) fail("QVI vLEI revoked");
  }

  // The holder's current signing key, from its key event log as known to the verifier.
  const [state] = await verifier.keyStates().get(holder);
  const key: string | undefined = state?.k?.[0];
  if (!key) fail("no key state for the role holder");
  else {
    const verfer = new Verfer({ qb64: key });
    const cigar = new Cigar({ qb64: args.signature });
    if (!verfer.verify(cigar.raw, new TextEncoder().encode(args.statement))) fail("binding signature invalid");
  }
  try {
    if (JSON.parse(args.statement).lei !== lei) fail("statement names a different LEI");
  } catch {
    fail("statement is not JSON");
  }

  return { ok: failures.length === 0, failures, lei, officialRole: oor.sad.a.officialRole, holder, oorSaid: oor.sad.d };
}

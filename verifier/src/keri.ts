import {
  Saider,
  Serder,
  SignifyClient,
  Tier,
  randomPasscode,
  ready,
  type Operation,
} from "signify-ts";

/**
 * Thin helpers over signify-ts for a KERIA agent. Written for Agent Passport; the call sequence follows
 * the public signify-ts integration tests (WebOfTrust/signify-ts, Apache-2.0) as a design reference.
 */

export const KERIA_URL = process.env.KERIA_URL ?? "http://127.0.0.1:3901";
export const KERIA_BOOT_URL = process.env.KERIA_BOOT_URL ?? "http://127.0.0.1:3903";
/** Witnesses and schema server as seen from inside the KERIA docker network (docs/VLEI_SETUP.md). */
export const WITNESS_IDS = [
  "BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha",
  "BLskRTInXnMxWaGqcpSyMgo0nYbalW99cGZESrz3zapM",
  "BIKKuvBwpmDVA4Ds-EpL5bt9OqPzWPja2LigFYZN2YfX",
];
export const VLEI_SERVER = process.env.VLEI_SERVER_URL ?? "http://vlei-server:7723";

export const SCHEMA = {
  QVI: "EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao",
  LE: "ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY",
  OOR_AUTH: "EKA57bKBKxr_kN7iN5i7lMUxpMG-s19dRcmov1iDxz-E",
  OOR: "EBNaNu-M9P5cgrnfl2Fvymy4E_jvxxyjb70PRtiANlJy",
} as const;

export interface Aid {
  name: string;
  prefix: string;
  oobi: string;
}

export async function connect(passcode?: string): Promise<{ client: SignifyClient; passcode: string }> {
  await ready();
  const bran = (passcode ?? randomPasscode()).padEnd(21, "_");
  const client = new SignifyClient(KERIA_URL, bran, Tier.low, KERIA_BOOT_URL);
  try {
    await client.connect();
  } catch {
    const res = await client.boot();
    if (!res.ok) throw new Error(`KERIA boot failed: ${res.status}`);
    await client.connect();
  }
  return { client, passcode: bran };
}

export async function waitOp(client: SignifyClient, op: Operation | string): Promise<Operation> {
  const o = typeof op === "string" ? await client.operations().get(op) : op;
  const done = await client.operations().wait(o, { signal: AbortSignal.timeout(60_000) });
  for (let x: Operation | undefined = done; x; x = (x.metadata as { depends?: Operation } | undefined)?.depends) {
    await client.operations().delete(x.name).catch(() => {});
  }
  return done;
}

async function retry<T>(fn: () => Promise<T>, tries = 40, delayMs = 1000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

export async function getOrCreateAid(client: SignifyClient, name: string): Promise<Aid> {
  let prefix: string;
  try {
    prefix = (await client.identifiers().get(name)).prefix;
  } catch {
    const res = await client.identifiers().create(name, { toad: WITNESS_IDS.length, wits: WITNESS_IDS });
    prefix = ((await waitOp(client, await res.op())) as unknown as { response: { i: string } }).response.i;
  }
  const eid = client.agent!.pre;
  const res = await client.fetch(`/identifiers/${name}/endroles/agent`, "GET", null);
  const roles = (res.ok ? await res.json() : []) as { role: string; eid: string }[];
  if (!roles.some((r) => r.role === "agent" && r.eid === eid)) {
    await waitOp(client, await (await client.identifiers().addEndRole(name, "agent", eid)).op());
  }
  const oobi = (await client.oobis().get(name, "agent")).oobis[0];
  return { name, prefix, oobi };
}

export async function resolveOobi(client: SignifyClient, oobi: string, alias?: string) {
  await waitOp(client, await client.oobis().resolve(oobi, alias));
}

export async function getOrCreateRegistry(client: SignifyClient, aid: Aid, registryName: string) {
  let regs = await client.registries().list(aid.name);
  if (regs.length === 0) {
    const r = await client.registries().create({ name: aid.name, registryName });
    await waitOp(client, await r.op());
    regs = await client.registries().list(aid.name);
  }
  return regs[0] as { regk: string };
}

export function edge(label: string, cred: { sad: { d: string; s: string } }, operator?: string) {
  return Saider.saidify({ d: "", [label]: { n: cred.sad.d, s: cred.sad.s, ...(operator ? { o: operator } : {}) } })[1];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cred = any;

/** Issue (idempotently) and deliver a credential over IPEX grant/admit. */
export async function issueAndDeliver(
  issuer: { client: SignifyClient; aid: Aid },
  holder: { client: SignifyClient; aid: Aid },
  registry: { regk: string },
  schema: string,
  data: Record<string, unknown>,
  opts: { rules?: unknown; source?: unknown } = {},
): Promise<Cred> {
  const existing = (await issuer.client.credentials().list()).find(
    (c: Cred) => c.sad.s === schema && c.sad.i === issuer.aid.prefix && c.sad.a.i === holder.aid.prefix,
  );
  let cred = existing;
  const tag = `${issuer.aid.name}→${holder.aid.name} ${schema.slice(0, 8)}`;
  if (!cred) {
    console.log(`  issue ${tag}`);
    const res = await issuer.client.credentials().issue(issuer.aid.name, {
      ri: registry.regk,
      s: schema,
      a: { i: holder.aid.prefix, ...data },
      r: opts.rules,
      e: opts.source,
    } as never);
    await waitOp(issuer.client, res.op);
    cred = await issuer.client.credentials().get(res.acdc.sad.d);
  }
  if (await received(holder.client, cred.sad.d)) return cred;
  console.log(`  grant ${tag}`);
  const grantSaid = await grant(issuer, holder.aid.prefix, cred);
  console.log(`  admit ${tag}`);
  await admitGrant(holder, issuer.aid.prefix, grantSaid);
  await retry(async () => {
    if (!(await received(holder.client, cred.sad.d))) throw new Error("not yet received");
  });
  return cred;
}

export async function received(client: SignifyClient, said: string) {
  const list = await client.credentials().list({ filter: { "-d": said } });
  return list.length > 0 ? list[0] : undefined;
}

const stamp = () => new Date().toISOString().replace("Z", "000+00:00");

/** IPEX grant: offer `cred` (with its anchoring events) to `recipient`. Also how a holder presents. */
export async function grant(from: { client: SignifyClient; aid: Aid }, recipient: string, cred: Cred) {
  const [exn, sigs, end] = await from.client.ipex().grant({
    senderName: from.aid.name,
    acdc: new Serder(cred.sad),
    anc: new Serder(cred.anc),
    iss: new Serder(cred.iss),
    ancAttachment: cred.ancatc ?? cred.ancAttachment,
    recipient,
    datetime: stamp(),
  } as never);
  await waitOp(from.client, await from.client.ipex().submitGrant(from.aid.name, exn, sigs, end, [recipient]));
  // KERIA also notifies the sender of its own grant; mark it so it is never mistaken for an incoming one.
  await markNotes(from.client, "/exn/ipex/grant", exn.said);
  return exn.said as string;
}

async function markNotes(client: SignifyClient, route: string, said: string) {
  await retry(async () => {
    const { notes } = await client.notifications().list();
    const mine = (notes as Cred[]).filter((x) => x.a.r === route && x.a.d === said);
    if (mine.length === 0) throw new Error("notification not there yet");
    for (const n of mine) await client.notifications().mark(n.i).catch(() => {});
  }, 15);
}

/** Wait for the IPEX grant `grantSaid` to arrive and admit it. */
export async function admitGrant(to: { client: SignifyClient; aid: Aid }, sender: string, grantSaid: string) {
  const note = await retry(async () => {
    const { notes } = await to.client.notifications().list();
    const n = (notes as Cred[]).find((x) => x.a.r === "/exn/ipex/grant" && x.a.d === grantSaid);
    if (!n) throw new Error("grant not received yet");
    return n;
  });
  const [exn, sigs, end] = await to.client.ipex().admit({
    senderName: to.aid.name,
    message: "",
    grantSaid,
    recipient: sender,
    datetime: stamp(),
  } as never);
  await waitOp(to.client, await to.client.ipex().submitAdmit(to.aid.name, exn, sigs, end, [sender]));
  await to.client.notifications().mark(note.i).catch(() => {});
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET as C, credentialStatus, credentialStatusRegistryAbi, deserializeCredential, monadTestnet } from "@agent-passport/sdk";
import { admitGrant, connect, getOrCreateAid, grant, received } from "./keri.js";
import { bindingStatement, checkOwner } from "./verifyOwner.js";

/**
 * npm run verify -w verifier [-- <credential.json>]
 *
 * 1. The treasury officer (OOR holder) signs a statement binding the Agent Passport credential to the
 *    legal entity, and presents the OOR credential to the verifier over IPEX.
 * 2. The verifier checks the vLEI chain to the trusted root and the signature (verifyOwner.ts).
 * 3. Only then it records VLEI_VERIFIED + keccak256(OOR SAID) for that credential on Monad.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const env: Record<string, string> = {};
for (const line of existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const chain = JSON.parse(readFileSync(join(root, "verifier", ".state", "chain.json"), "utf8"));
const held = deserializeCredential(readFileSync(process.argv[2] ?? join(root, "demo", ".state", "credential.json"), "utf8"));
const pc = createPublicClient({ chain: monadTestnet, transport: http(env.MONAD_TESTNET_RPC_URL) });

const before = await credentialStatus(pc as never, C.credentialStatusRegistry, held.credentialId);
console.log(`Agent Passport credential ${held.credentialId}: ${before.status}, owner assurance ${before.ownerAssurance}`);
if (before.status !== "Active") throw new Error("credential is not active on-chain");

// ---- 1. the role holder binds the credential and presents the OOR
const role = await connect(chain.passcodes.role);
const ver = await connect(chain.passcodes.verifier);
const roleAid = await getOrCreateAid(role.client, "role");
const verAid = await getOrCreateAid(ver.client, "verifier");

const statement = bindingStatement({
  chainId: 10143,
  statusRegistry: C.credentialStatusRegistry,
  credentialId: held.credentialId,
  issuer: held.authorization.issuer,
  lei: chain.lei,
});
const hab = await role.client.identifiers().get("role");
const [signature] = await role.client.manager!.get(hab).sign(new TextEncoder().encode(statement), false);
console.log("officer signed the binding statement");

const oor = await role.client.credentials().get(chain.credentials.oor);
if (!(await received(ver.client, oor.sad.d))) {
  const said = await grant({ client: role.client, aid: roleAid }, verAid.prefix, oor);
  await admitGrant({ client: ver.client, aid: verAid }, roleAid.prefix, said);
  for (let i = 0; i < 45 && !(await received(ver.client, oor.sad.d)); i++) await new Promise((r) => setTimeout(r, 1000));
}
console.log("OOR credential presented to the verifier over IPEX");

// ---- 2. verify (plus two negative controls)
const result = await checkOwner(ver.client, { oorSaid: oor.sad.d, trustedRoot: chain.trustedRoot, statement, signature });
const tampered = await checkOwner(ver.client, {
  oorSaid: oor.sad.d,
  trustedRoot: chain.trustedRoot,
  statement: statement.replace(held.credentialId, `0x${"00".repeat(32)}`),
  signature,
});
const wrongRoot = await checkOwner(ver.client, { oorSaid: oor.sad.d, trustedRoot: "EUntrustedRoot000000000000000000000000000000", statement, signature });
console.log(`verification: ${result.ok ? "PASS" : "FAIL " + result.failures.join("; ")}`);
console.log(`control — statement for another credential: ${tampered.ok ? "PASS (unexpected!)" : "rejected: " + tampered.failures.join("; ")}`);
console.log(`control — untrusted root: ${wrongRoot.ok ? "PASS (unexpected!)" : "rejected: " + wrongRoot.failures.join("; ")}`);
if (!result.ok || tampered.ok || wrongRoot.ok) process.exit(1);

// ---- 3. record the result on Monad
const saidHash = keccak256(stringToHex(result.oorSaid!));
const wallet = createWalletClient({ chain: monadTestnet, transport: http(env.MONAD_TESTNET_RPC_URL), account: privateKeyToAccount((env.VLEI_VERIFIER_KEY || env.DEPLOYER_PRIVATE_KEY) as Hex) });
const hash = await wallet.writeContract({
  address: C.credentialStatusRegistry,
  abi: credentialStatusRegistryAbi,
  functionName: "recordOwnerAssurance",
  args: [held.credentialId, 1, saidHash],
});
const receipt = await pc.waitForTransactionReceipt({ hash });
const after = await credentialStatus(pc as never, C.credentialStatusRegistry, held.credentialId);
console.log(`recorded on Monad: ${after.ownerAssurance} (tx ${hash}, block ${receipt.blockNumber})`);

writeFileSync(
  join(root, "demo", "public", "runs", "vlei-latest.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      credentialId: held.credentialId,
      holderAid: result.holder,
      officialRole: result.officialRole,
      lei: result.lei,
      oorSaid: result.oorSaid,
      oorSaidHash: saidHash,
      checks: { valid: result.ok, tamperedStatementRejected: !tampered.ok, untrustedRootRejected: !wrongRoot.ok },
      tx: hash,
      block: receipt.blockNumber.toString(),
      ownerAssurance: after.ownerAssurance,
      note: "Test vLEI chain on a local KERIA stack; fictional entity and LEI.",
    },
    null,
    2,
  ),
);

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import {
  MONAD_TESTNET as C,
  buildIntent,
  chainNow,
  checkAuthorization,
  passportDexAbi,
  passportGateAbi,
  signIntent,
  toGatePresentation,
} from "@agent-passport/sdk";
import { repoRoot } from "./env.js";
import { Scenario } from "./scenario.js";

/**
 * npm run bench -w demo [-- N]
 *
 * One agent submits N authorized swaps at once. PassportGate uses unordered nonces, so the actions do
 * not queue behind each other at the protocol level; each is fully verified on-chain (identity,
 * mandate status, four Merkle proofs, key-binding signature, daily budget) and settled.
 */
const N = Number(process.argv[2] ?? 8);
const AMOUNT = 5_000_000n; // 5 apUSD each

const s = new Scenario();
s.loadCredential();
const { publicClient, agent } = s.a;
const held = s.held!;
const presentation = toGatePresentation(held, { scope: "dex.swap", asset: C.demoUsd, relyingParty: C.passportDex });

const pre = await checkAuthorization(publicClient as never, C.passportGate, {
  agentId: held.authorization.agentId,
  scope: "dex.swap",
  asset: C.demoUsd,
  amount: AMOUNT * BigInt(N),
  relyingParty: C.passportDex,
  presentation,
});
if (!pre.authorized) throw new Error(`mandate cannot cover ${N} × 5 apUSD today: ${pre.reason} (issue a fresh one)`);

const abi = [...passportDexAbi, ...passportGateAbi.filter((x) => x.type === "error")];
const now = await chainNow(publicClient as never); // chain time, not the local clock
const intents = Array.from({ length: N }, () =>
  buildIntent({ credentialId: held.credentialId, scope: "dex.swap", asset: C.demoUsd, amount: AMOUNT, relyingParty: C.passportDex, now }),
);
const sigs = await Promise.all(intents.map((i) => signIntent(agent.account as never, 10143, C.passportGate, i)));
const gas =
  ((await publicClient.estimateContractGas({
    address: C.passportDex,
    abi,
    functionName: "swap",
    args: [intents[0], presentation, sigs[0], 0n],
    account: agent.account!,
  })) * 125n) / 100n;
const baseNonce = await publicClient.getTransactionCount({ address: agent.account!.address, blockTag: "pending" });
const startBlock = await publicClient.getBlockNumber();

const t0 = Date.now();
const hashes: Hex[] = await Promise.all(
  intents.map((intent, k) =>
    agent.writeContract({
      address: C.passportDex,
      abi,
      functionName: "swap",
      args: [intent, presentation, sigs[k], 0n],
      account: agent.account!,
      chain: agent.chain,
      gas,
      nonce: baseNonce + k,
    }),
  ),
);
const tSent = Date.now() - t0;
const receipts = await Promise.all(hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })));
const tAll = Date.now() - t0;

const blocks = receipts.map((r) => r.blockNumber);
const min = blocks.reduce((a, b) => (a < b ? a : b));
const max = blocks.reduce((a, b) => (a > b ? a : b));
const result = {
  at: new Date().toISOString(),
  actions: N,
  succeeded: receipts.filter((r) => r.status === "success").length,
  submitMs: tSent,
  allReceiptsMs: tAll,
  blocksSpanned: Number(max - min) + 1,
  firstBlockAfterSubmit: Number(min - startBlock),
  gasUsedPerAction: receipts[0].gasUsed.toString(),
  txs: receipts.map((r) => ({ hash: r.transactionHash, block: r.blockNumber.toString(), status: r.status })),
};
console.log(
  `${result.succeeded}/${N} verified agent actions settled in ${result.blocksSpanned} block(s), ` +
    `${result.allReceiptsMs} ms from first submit to last receipt`,
);
for (const t of result.txs) console.log(`  block ${t.block} ${t.status} https://testnet.monadscan.com/tx/${t.hash}`);
const dir = join(repoRoot, "demo", "public", "runs");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "bench-latest.json"), JSON.stringify(result, null, 2));

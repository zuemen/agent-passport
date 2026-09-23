import { createPublicClient, http, type Address, type Hex } from "viem";
import {
  MONAD_TESTNET,
  checkAuthorization,
  credentialStatus,
  mockTokenAbi,
  monadTestnet,
  type GatePresentation,
} from "@agent-passport/sdk";
import type { RunLog, StepLog } from "../scenario/types";

export const C = MONAD_TESTNET;
export const client = createPublicClient({ chain: monadTestnet, transport: http() });
export const API = (import.meta.env.VITE_DEMO_API as string | undefined) ?? "http://127.0.0.1:18790";

export const explorerTx = (h: string) => `https://testnet.monadscan.com/tx/${h}`;
export const explorerAddr = (a: string) => `https://testnet.monadscan.com/address/${a}`;
export const short = (h?: string, n = 6) => (h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : "—");

export async function loadRecordedRun(): Promise<RunLog> {
  const r = await fetch(`${import.meta.env.BASE_URL}runs/latest.json`, { cache: "no-store" });
  return r.json();
}

/** Live mode is available when the local demo API (npm run api) answers. */
export async function probeLive(): Promise<boolean> {
  try {
    const r = await fetch(`${API}/api/state`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function fetchLiveReport(): Promise<{ report?: RunLog }> {
  const r = await fetch(`${API}/api/state`);
  return r.json();
}

export async function runLiveStep(step: string): Promise<{ steps: StepLog[]; report?: RunLog; error?: string }> {
  const r = await fetch(`${API}/api/step/${step}`, { method: "POST" });
  return r.json();
}

export interface LiveState {
  status: string;
  ownerAssurance: string;
  agentUsd: bigint;
  ownerUsd: bigint;
  block: bigint;
}

export async function readLive(run: RunLog): Promise<LiveState> {
  const [s, agentUsd, ownerUsd, block] = await Promise.all([
    credentialStatus(client as never, C.credentialStatusRegistry, run.credentialId as Hex),
    client.readContract({ address: C.demoUsd, abi: mockTokenAbi, functionName: "balanceOf", args: [run.agentWallet as Address] }),
    client.readContract({ address: C.demoUsd, abi: mockTokenAbi, functionName: "balanceOf", args: [run.owner as Address] }),
    client.getBlockNumber(),
  ]);
  return { status: s.status, ownerAssurance: s.ownerAssurance, agentUsd, ownerUsd, block };
}

export async function liveGateCheck(run: RunLog, which: "dex" | "merchant", amountUsd: number) {
  const scope = which === "dex" ? "dex.swap" : "commerce.pay";
  const relyingParty = which === "dex" ? C.passportDex : C.passportMerchant;
  return checkAuthorization(client as never, C.passportGate, {
    agentId: BigInt(run.agentId),
    scope,
    asset: C.demoUsd,
    amount: BigInt(Math.round(amountUsd * 1e6)),
    relyingParty,
    presentation: run.gatePresentations[which] as GatePresentation,
  });
}

export const usd = (base: bigint | string | number) => {
  const n = Number(BigInt(base)) / 1e6;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
};

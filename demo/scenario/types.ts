/** Shape of demo/public/runs/*.json — written by the scenario, rendered by the demo app. */

export type Role = "owner" | "agent" | "verifier" | "vlei";

export interface StepLog {
  id: string;
  role: Role;
  title: string;
  /** What the step demonstrates. */
  expect: "success" | "rejected" | "offchain";
  outcome: "success" | "rejected" | "offchain";
  /** PassportGate reason (decoded from a pre-flight call) for rejected actions. */
  reason?: string;
  txHash?: string;
  block?: string;
  gasUsed?: string;
  /** Wall clock from submitting the transaction to having its receipt. */
  latencyMs?: number;
  detail?: Record<string, string>;
}

export interface RunLog {
  version: 1;
  startedAt: string;
  finishedAt: string;
  chainId: number;
  explorer: string;
  contracts: Record<string, string>;
  owner: string;
  agentWallet: string;
  agentId: string;
  credentialId: string;
  /** What the DEX (verifier) learns vs. what stays with the agent. */
  verifierView: { disclosed: { name: string; value: string }[]; hiddenClaimCount: number };
  /** Everything the owner signed (fictional test data; salts omitted). Only the owner and agent see this. */
  ownerClaims: { name: string; display: string }[];
  /** Exactly what the agent handed each relying party (already public: it travels in the tx calldata). */
  gatePresentations: Record<"dex" | "merchant", unknown>;
  setup: StepLog[];
  steps: StepLog[];
  metrics: {
    medianLatencyMs: number;
    revokeBlock?: string;
    firstRejectedAfterRevokeBlock?: string;
    blocksFromRevokeToRejection?: number;
    successfulSwapGas?: string;
  };
}

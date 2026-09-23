import type { Address } from "viem";

/** ERC-8004 agent registration file (Draft, 2026-01-25), with the Agent Passport services added. */
export interface RegistrationFile {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  image?: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
}

export function buildRegistrationFile(opts: {
  name: string;
  description: string;
  image?: string;
  chainId: number;
  identityRegistry: Address;
  agentId: bigint;
  /** Streamable HTTP endpoint of this agent's Agent Passport MCP server. */
  mcpEndpoint?: string;
  passportGate: Address;
}): RegistrationFile {
  const services: RegistrationFile["services"] = [];
  if (opts.mcpEndpoint) services.push({ name: "MCP", endpoint: opts.mcpEndpoint, version: "2025-06-18" });
  // Where counterparties verify this agent's authorization before acting with it.
  services.push({ name: "AgentPassportGate", endpoint: `eip155:${opts.chainId}:${opts.passportGate}`, version: "1" });
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: opts.name,
    description: opts.description,
    ...(opts.image ? { image: opts.image } : {}),
    services,
    x402Support: false,
    active: true,
    registrations: [{ agentId: Number(opts.agentId), agentRegistry: `eip155:${opts.chainId}:${opts.identityRegistry}` }],
    supportedTrust: ["reputation", "agent-passport-credential"],
  };
}

/** Fully on-chain agentURI, as the ERC recommends for on-chain storage. */
export function toDataUri(file: RegistrationFile): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file), "utf8").toString("base64")}`;
}

export function fromDataUri(uri: string): RegistrationFile {
  const prefix = "data:application/json;base64,";
  if (!uri.startsWith(prefix)) throw new Error("not a base64 JSON data URI");
  return JSON.parse(Buffer.from(uri.slice(prefix.length), "base64").toString("utf8"));
}

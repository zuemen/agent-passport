import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Hex, type WalletClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
export const bytecode: Record<string, Hex> = JSON.parse(readFileSync(join(here, "fixtures", "bytecode.json"), "utf8"));

const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public dev mnemonic

export async function startAnvil(port: number) {
  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", "31337"], {
    stdio: "ignore",
  });
  const chain = defineChain({
    id: 31337,
    name: "anvil",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 50 });
  const probe = createPublicClient({ chain, transport: http(undefined, { timeout: 1_000, retryCount: 0 }) });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      await probe.getChainId();
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // On Windows, Hyper-V reserves port ranges (`netsh interface ipv4 show excludedportrange protocol=tcp`);
  // anvil then fails to bind with os error 10013. Pick ports outside those ranges.
  if (!up) throw new Error(`anvil did not come up on port ${port}`);
  const wallet = (index: number) =>
    createWalletClient({ chain, transport: http(), account: mnemonicToAccount(MNEMONIC, { addressIndex: index }) });
  return { proc, chain, publicClient, wallet, account: (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i }) };
}

export async function deploy(
  wallet: WalletClient,
  publicClient: ReturnType<typeof createPublicClient>,
  name: string,
  abi: Abi,
  args: unknown[] = [],
) {
  const hash = await wallet.deployContract({ abi, bytecode: bytecode[name], args, account: wallet.account!, chain: wallet.chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`deploy ${name} failed`);
  return receipt.contractAddress;
}

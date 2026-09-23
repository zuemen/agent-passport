import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { passkeyAccountAbi } from "./abi.js";

/**
 * Passkey (WebAuthn / P-256) owner support. The owner is a PasskeyAccount contract; a biometric prompt
 * signs an EIP-712 digest used verbatim as the WebAuthn challenge, and anyone can relay the call.
 */

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export interface WebAuthnAuth {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
}

export interface PasskeyCall {
  target: Address;
  value: bigint;
  data: Hex;
}

/** A raw WebAuthn assertion, as returned by navigator.credentials.get() or a software authenticator. */
export interface WebAuthnAssertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** DER-encoded ECDSA signature. */
  signature: Uint8Array;
}

/** Parse a DER ECDSA signature into (r, s) with s in the lower half (the contract rejects high-s). */
export function parseDerSignature(der: Uint8Array): { r: Hex; s: Hex } {
  let i = 2; // 0x30 len
  if (der[1] & 0x80) i += der[1] & 0x7f;
  const read = () => {
    if (der[i] !== 0x02) throw new Error("bad DER signature");
    const len = der[i + 1];
    const bytes = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    return BigInt(toHex(bytes));
  };
  const r = read();
  let s = read();
  if (s > P256_N / 2n) s = P256_N - s;
  return { r: toHex(r, { size: 32 }), s: toHex(s, { size: 32 }) };
}

export function toWebAuthnAuth(a: WebAuthnAssertion): WebAuthnAuth {
  const json = new TextDecoder().decode(a.clientDataJSON);
  const typeIndex = json.indexOf('"type":"webauthn.get"');
  const challengeIndex = json.indexOf('"challenge":"');
  if (typeIndex < 0 || challengeIndex < 0) throw new Error("clientDataJSON lacks type/challenge");
  const { r, s } = parseDerSignature(a.signature);
  return {
    r,
    s,
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    authenticatorData: toHex(a.authenticatorData),
    clientDataJSON: json,
  };
}

const AUTH_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
      { name: "challengeIndex", type: "uint256" },
      { name: "typeIndex", type: "uint256" },
      { name: "authenticatorData", type: "bytes" },
      { name: "clientDataJSON", type: "string" },
    ],
  },
] as const;

/** ERC-1271 signature format of PasskeyAccount: abi.encode(WebAuthnAuth). */
export function encodeWebAuthnSignature(auth: WebAuthnAuth): Hex {
  return encodeAbiParameters(AUTH_TUPLE, [auth]);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hexToBytes32(h: Hex): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** Build a call for PasskeyAccount.execute. */
export function passkeyCall(target: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n): PasskeyCall {
  return { target, value, data: encodeFunctionData({ abi, functionName, args } as never) };
}

/** The digest the passkey must sign for `execute(calls, deadline)` (read from the account itself). */
export async function executeDigest(client: PublicClient, account: Address, calls: PasskeyCall[], deadline: bigint) {
  const nonce = await client.readContract({ address: account, abi: passkeyAccountAbi, functionName: "nonce" });
  const digest = await client.readContract({
    address: account,
    abi: passkeyAccountAbi,
    functionName: "executeDigest",
    args: [calls, nonce, deadline],
  });
  return { digest, nonce };
}

/**
 * A viem-compatible typed-data signer backed by a passkey, for issuing credentials whose issuer is a
 * PasskeyAccount. The signature is verified through ERC-1271 (`verifyPresentation` with a client).
 */
export function passkeyTypedDataSigner(account: Address, sign: (challenge: Uint8Array) => Promise<WebAuthnAssertion>) {
  return {
    address: account,
    type: "local" as const,
    async signTypedData(args: Parameters<typeof hashTypedData>[0]): Promise<Hex> {
      const digest = hashTypedData(args);
      return encodeWebAuthnSignature(toWebAuthnAuth(await sign(hexToBytes32(digest))));
    },
  };
}

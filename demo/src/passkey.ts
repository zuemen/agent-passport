import { API } from "./chain";

/** The user's real platform passkey (Windows Hello, Touch ID, Face ID, Android), via WebAuthn. */

export interface StoredPasskey {
  id: string; // credential id, base64url
  qx: `0x${string}`;
  qy: `0x${string}`;
}

const KEY = "agent-passport.passkey";
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;

export function loadPasskey(): StoredPasskey | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as StoredPasskey) : undefined;
  } catch {
    return undefined;
  }
}

export function passkeySupported() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

export async function createPasskey(): Promise<StoredPasskey> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Agent Passport demo" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "treasury-owner", displayName: "Treasury owner (demo)" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 = P-256, verified by Monad's 0x0100 precompile
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      timeout: 120_000,
    },
  })) as PublicKeyCredential;
  const response = cred.response as AuthenticatorAttestationResponse;
  const spki = new Uint8Array(response.getPublicKey()!);
  const point = spki.slice(spki.length - 65); // 0x04 ‖ X ‖ Y
  if (point[0] !== 0x04) throw new Error("unexpected public key format");
  const pk: StoredPasskey = { id: b64u(cred.rawId), qx: hex(point.slice(1, 33)), qy: hex(point.slice(33, 65)) };
  try {
    localStorage.setItem(KEY, JSON.stringify(pk));
  } catch {
    /* private mode: keep in memory only */
  }
  return pk;
}

/** Sign the server's challenge with the passkey and hand the assertion back to the relaying API. */
export async function approve(pk: StoredPasskey, challengeHex: string) {
  const challenge = Uint8Array.from(challengeHex.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: "public-key", id: fromB64u(pk.id) }],
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAssertionResponse;
  const res = await fetch(`${API}/api/passkey/assertion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authenticatorData: b64u(r.authenticatorData), clientDataJSON: b64u(r.clientDataJSON), signature: b64u(r.signature) }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "approval failed");
}

export async function startPasskeyAction(action: string, pk: StoredPasskey) {
  const res = await fetch(`${API}/api/passkey/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, qx: pk.qx, qy: pk.qy }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "could not start");
}

export interface PasskeyStatus {
  job?: { action: string; status: "running" | "done" | "error"; error?: string };
  pending: { challenge: string; purpose: string } | null;
  account?: string;
  agentId?: string;
  credentialId?: string;
  steps: { step: string; tx?: string; block?: string; status?: string; reason?: string }[];
}

export async function passkeyStatus(): Promise<PasskeyStatus> {
  return (await fetch(`${API}/api/passkey/status`)).json();
}

import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Hex } from "viem";
import { base64UrlEncode, type WebAuthnAssertion } from "../src/index.js";

/**
 * A software WebAuthn authenticator (P-256), producing assertions in exactly the browser format:
 * clientDataJSON with type "webauthn.get" and a base64url challenge, authenticatorData with UP+UV
 * flags, DER signature over sha256(authData ‖ sha256(clientDataJSON)). For tests and scripts; the demo
 * app uses a real platform passkey (Windows Hello / Touch ID / Face ID).
 */
export class SoftPasskey {
  readonly x: Hex;
  readonly y: Hex;
  private counter = 0;

  constructor(private readonly key: KeyObject, private readonly rpId = "agent-passport.demo") {
    const jwk = key.export({ format: "jwk" });
    const hex = (b64: string) => `0x${Buffer.from(b64, "base64url").toString("hex")}` as Hex;
    this.x = hex(jwk.x!);
    this.y = hex(jwk.y!);
  }

  static generate() {
    return new SoftPasskey(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
  }

  static fromPem(pem: string) {
    return new SoftPasskey(createPrivateKey(pem));
  }

  toPem(): string {
    return this.key.export({ format: "pem", type: "pkcs8" }) as string;
  }

  async sign(challenge: Uint8Array): Promise<WebAuthnAssertion> {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: base64UrlEncode(challenge), origin: `https://${this.rpId}`, crossOrigin: false }),
    );
    const flags = Buffer.from([0x05]); // user present + user verified
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    const authenticatorData = Buffer.concat([createHash("sha256").update(this.rpId).digest(), flags, count]);
    const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
    const signature = sign("sha256", signed, this.key); // DER
    return { authenticatorData, clientDataJSON, signature };
  }
}

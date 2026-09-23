import { encodeAbiParameters, keccak256, toHex, stringToHex, type Address, type Hex } from "viem";

/**
 * Claim keys and leaf encoding. Must match contracts/src/libraries/PassportClaims.sol exactly.
 *
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(salt, key, value))))
 *
 * which is also the leaf format of OpenZeppelin's StandardMerkleTree for ["bytes32","bytes32","bytes32"].
 */

export const KEY_SCOPE: Hex = keccak256(stringToHex("agentpassport:scope"));
export const ALLOWED: Hex = toHex(1n, { size: 32 });

const stringAddress = [{ type: "string" }, { type: "address" }] as const;

export function maxPerTxKey(asset: Address): Hex {
  return keccak256(encodeAbiParameters(stringAddress, ["agentpassport:maxPerTx", asset]));
}

export function dailyLimitKey(asset: Address): Hex {
  return keccak256(encodeAbiParameters(stringAddress, ["agentpassport:dailyLimit", asset]));
}

export function payeeKey(relyingParty: Address): Hex {
  return keccak256(encodeAbiParameters(stringAddress, ["agentpassport:payee", relyingParty]));
}

/** Key for a free-form private claim, e.g. "purpose" -> keccak256("agentpassport:purpose"). */
export function textKey(name: string): Hex {
  return keccak256(stringToHex(`agentpassport:${name}`));
}

export function scopeHash(scope: string): Hex {
  return keccak256(stringToHex(scope));
}

export function leaf(salt: Hex, key: Hex, value: Hex): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [salt, key, value]),
  );
  return keccak256(inner);
}

export function uint256ToBytes32(v: bigint): Hex {
  return toHex(v, { size: 32 });
}

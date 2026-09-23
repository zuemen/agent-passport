// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PassportClaims
/// @notice Claim keys and leaf encoding shared by the contracts and the TypeScript SDK.
///
/// A credential's claims are turned into salted digests, one per claim:
///     leaf = keccak256(bytes.concat(keccak256(abi.encode(salt, key, value))))
/// and the digests are committed to with a sorted-pair Merkle tree — the same layout as
/// OpenZeppelin's `StandardMerkleTree` with leaf types ["bytes32","bytes32","bytes32"].
/// Revealing one claim means revealing its (salt, key, value) plus a Merkle proof; every other claim
/// stays hidden behind its random salt. This is the SD-JWT "salted digest" idea, with a Merkle root
/// instead of a digest array so it can be checked cheaply on-chain.
library PassportClaims {
    /// Value = keccak256 of the scope string, e.g. keccak256("dex.swap").
    bytes32 internal constant KEY_SCOPE = keccak256("agentpassport:scope");

    /// Largest single action in `asset` base units. The claim existing at all is what grants the asset.
    /// AP2: amount_range.max
    function maxPerTxKey(address asset) internal pure returns (bytes32) {
        return keccak256(abi.encode("agentpassport:maxPerTx", asset));
    }

    /// Cumulative cap in `asset` base units per UTC day, enforced by PassportGate. AP2: budget + recurrence.
    function dailyLimitKey(address asset) internal pure returns (bytes32) {
        return keccak256(abi.encode("agentpassport:dailyLimit", asset));
    }

    /// The relying party (contract that calls PassportGate) is an allowed payee. AP2: allowed_payees.
    function payeeKey(address relyingParty) internal pure returns (bytes32) {
        return keccak256(abi.encode("agentpassport:payee", relyingParty));
    }

    bytes32 internal constant ALLOWED = bytes32(uint256(1));

    function leaf(bytes32 salt, bytes32 key, bytes32 value) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(salt, key, value))));
    }
}

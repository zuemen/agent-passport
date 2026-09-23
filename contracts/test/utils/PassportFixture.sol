// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentIdentityRegistry} from "../../src/AgentIdentityRegistry.sol";
import {CredentialStatusRegistry} from "../../src/CredentialStatusRegistry.sol";
import {PassportGate} from "../../src/PassportGate.sol";
import {PassportClaims} from "../../src/libraries/PassportClaims.sol";
import {IAgentIdentity} from "../../src/interfaces/IAgentIdentity.sol";

/// @dev Shared setup: an owner, an agent wallet, a registered agent and a helper that builds a
///      credential (claims -> salted leaves -> sorted-pair Merkle tree) the same way the SDK does.
abstract contract PassportFixture is Test {
    AgentIdentityRegistry internal identity;
    CredentialStatusRegistry internal status;
    PassportGate internal gate;

    address internal owner = makeAddr("owner");
    address internal vleiVerifier = makeAddr("vlei-verifier");
    uint256 internal agentKey = 0xA11CE;
    address internal agentWallet;
    uint256 internal agentId;

    bytes32 internal constant SWAP = keccak256("dex.swap");
    bytes32 internal constant LEND = keccak256("lending.borrow");

    struct Claim {
        bytes32 salt;
        bytes32 key;
        bytes32 value;
    }

    /// The claims of the credential built by `_issue`, and its tree levels.
    Claim[] internal claims;
    bytes32[][] internal levels;

    function _deployCore() internal {
        vm.warp(1_790_000_000); // 2026-09-21, away from zero so day buckets are realistic
        identity = new AgentIdentityRegistry();
        status = new CredentialStatusRegistry(IAgentIdentity(address(identity)), address(this));
        status.setVleiVerifier(vleiVerifier, true);
        gate = new PassportGate(IAgentIdentity(address(identity)), status);

        agentWallet = vm.addr(agentKey);
        vm.prank(owner);
        agentId = identity.register("ipfs://agent-card");
        _bindWallet(agentId, agentKey);
    }

    function _bindWallet(uint256 id, uint256 walletKey) internal {
        address wallet = vm.addr(walletKey);
        uint256 deadline = block.timestamp + 60;
        bytes32 digest = _identityDigest(id, wallet, identity.ownerOf(id), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletKey, digest);
        vm.prank(identity.ownerOf(id));
        identity.setAgentWallet(id, wallet, deadline, abi.encodePacked(r, s, v));
    }

    function _identityDigest(uint256 id, address wallet, address own, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(identity.AGENT_WALLET_SET_TYPEHASH(), id, wallet, own, deadline));
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = identity.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    // ------------------------------------------------------------------ credential building

    /// Standard demo credential: dex.swap + lending.borrow scopes, `asset` capped per tx and per day,
    /// `payee` allowed, plus private claims (owner name, purpose) that are never disclosed.
    /// Indices: 0 scope(swap) 1 scope(lend) 2 maxPerTx 3 dailyLimit 4 ownerName 5 purpose 6 payee
    function _defaultClaims(address asset, uint256 maxPerTx, uint256 daily, address payee) internal {
        delete claims;
        claims.push(Claim(keccak256("s0"), PassportClaims.KEY_SCOPE, SWAP));
        claims.push(Claim(keccak256("s1"), PassportClaims.KEY_SCOPE, LEND));
        claims.push(Claim(keccak256("s2"), PassportClaims.maxPerTxKey(asset), bytes32(maxPerTx)));
        claims.push(Claim(keccak256("s3"), PassportClaims.dailyLimitKey(asset), bytes32(daily)));
        claims.push(Claim(keccak256("s4"), keccak256("agentpassport:ownerName"), keccak256("Alice Chen")));
        claims.push(Claim(keccak256("s5"), keccak256("agentpassport:purpose"), keccak256("rebalance savings")));
        claims.push(Claim(keccak256("s6"), PassportClaims.payeeKey(payee), PassportClaims.ALLOWED));
    }

    function _root() internal returns (bytes32) {
        delete levels;
        bytes32[] memory leaves = new bytes32[](claims.length);
        for (uint256 i; i < claims.length; ++i) {
            leaves[i] = PassportClaims.leaf(claims[i].salt, claims[i].key, claims[i].value);
        }
        levels.push(leaves);
        while (levels[levels.length - 1].length > 1) {
            bytes32[] memory cur = levels[levels.length - 1];
            bytes32[] memory next = new bytes32[]((cur.length + 1) / 2);
            for (uint256 i; i < next.length; ++i) {
                uint256 l = 2 * i;
                next[i] = l + 1 < cur.length ? _hashPair(cur[l], cur[l + 1]) : cur[l];
            }
            levels.push(next);
        }
        return levels[levels.length - 1][0];
    }

    function _proof(uint256 index) internal view returns (bytes32[] memory proof) {
        bytes32[] memory tmp = new bytes32[](levels.length);
        uint256 n;
        for (uint256 lv; lv < levels.length - 1; ++lv) {
            uint256 sib = index ^ 1;
            if (sib < levels[lv].length) tmp[n++] = levels[lv][sib];
            index /= 2;
        }
        proof = new bytes32[](n);
        for (uint256 i; i < n; ++i) proof[i] = tmp[i];
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _disclose(uint256 index) internal view returns (PassportGate.Disclosure memory) {
        return PassportGate.Disclosure(claims[index].salt, claims[index].key, claims[index].value, _proof(index));
    }

    /// Anchor the current claims as credential `id`, valid now for 30 days.
    function _anchor(bytes32 id) internal returns (bytes32 root) {
        root = _root();
        vm.prank(owner);
        status.anchor(id, agentId, root, uint64(block.timestamp), uint64(block.timestamp + 30 days));
    }

    function _presentation(bytes32 id) internal view returns (PassportGate.Presentation memory p) {
        p.credentialId = id;
        p.scope = _disclose(0);
        p.maxPerTx = _disclose(2);
        p.dailyLimit = _disclose(3);
        p.payee = _disclose(6);
    }

    /// The off-chain vLEI verifier (signify-ts + KERIA in production) records its result on-chain.
    function _markVleiVerified(bytes32 id) internal {
        vm.prank(vleiVerifier);
        status.recordOwnerAssurance(id, CredentialStatusRegistry.OwnerAssurance.VLEI_VERIFIED, keccak256("EOOR-SAID"));
    }

    function _signIntent(uint256 key, PassportGate.ActionIntent memory intent) internal view returns (bytes memory) {
        bytes32 digest = PassportGate(address(gate)).hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

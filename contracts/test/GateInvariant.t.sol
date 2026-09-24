// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PassportGate} from "../src/PassportGate.sol";
import {CredentialStatusRegistry} from "../src/CredentialStatusRegistry.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";

/// @dev Fuzzed actor: a relying party that keeps asking the gate to authorize random amounts across random
///      time jumps, immediately resubmits every intent the gate authorized, and at some point sees the owner
///      revoke the mandate. Rejected calls are expected and swallowed.
contract GateHandler is PassportFixture {
    PassportGate internal g;
    CredentialStatusRegistry internal reg;
    address internal principal;
    bytes32 internal cid;
    address internal asset;
    uint256 internal key;
    PassportGate.Presentation internal pres;
    uint256 public nonce;
    uint256 public maxSingleAuthorized;
    bool public revoked;
    uint256 public authorizedAfterRevoke;
    uint256 public replaysAccepted;

    constructor(
        PassportGate g_,
        CredentialStatusRegistry reg_,
        address principal_,
        bytes32 cid_,
        address asset_,
        uint256 key_,
        PassportGate.Presentation memory p
    ) {
        g = g_;
        reg = reg_;
        principal = principal_;
        cid = cid_;
        asset = asset_;
        key = key_;
        pres.credentialId = p.credentialId;
        pres.scope = p.scope;
        pres.maxPerTx = p.maxPerTx;
        pres.dailyLimit = p.dailyLimit;
        pres.payee = p.payee;
    }

    function act(uint256 amount, uint256 jump) external {
        amount = bound(amount, 0, 300e6);
        jump = bound(jump, 0, 2 days);
        vm.warp(vm.getBlockTimestamp() + jump);
        PassportGate.ActionIntent memory i = PassportGate.ActionIntent(
            cid, keccak256("dex.swap"), asset, amount, address(this), ++nonce, vm.getBlockTimestamp() + 60
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, g.hashIntent(i));
        bytes memory sig = abi.encodePacked(r, s, v);
        try g.authorize(i, pres, sig) {
            if (amount > maxSingleAuthorized) maxSingleAuthorized = amount;
            if (revoked) ++authorizedAfterRevoke;
            // Resubmit the same intent at the same moment: only its single-use nonce stands in the way.
            try g.authorize(i, pres, sig) {
                ++replaysAccepted;
            } catch {}
        } catch {}
    }

    /// The owner revokes the mandate: once, after at least 40 actions, on about one call in eight.
    function revoke(uint256 seed) external {
        if (revoked || nonce < 40 || seed % 8 != 0) return;
        vm.prank(principal);
        reg.revoke(cid, "invariant");
        revoked = true;
    }
}

contract GateInvariantTest is PassportFixture {
    GateHandler internal handler;
    bytes32 internal constant CID = keccak256("vc-inv");
    address internal constant ASSET = address(0xA55E7);
    uint256 internal constant MAX = 100e6;
    uint256 internal constant DAILY = 250e6;

    function setUp() public {
        _deployCore();
        // The handler is the relying party, so the payee claim names it. Deploy it at a known address:
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        _defaultClaims(ASSET, MAX, DAILY, predicted);
        // Valid for ten years, so that time jumps never expire it: a refusal after revocation must come
        // from the revocation.
        vm.prank(owner);
        status.anchor(CID, agentId, _root(), uint64(block.timestamp), uint64(block.timestamp + 3650 days));
        handler = new GateHandler(gate, status, owner, CID, ASSET, agentKey, _presentation(CID));
        assertEq(address(handler), predicted);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = GateHandler.act.selector;
        selectors[1] = GateHandler.revoke.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Whatever the sequence of calls and time jumps, today's booked spend never exceeds the daily
    /// limit, and no single authorized action exceeded the per-tx limit.
    function invariant_spendWithinLimits() public view {
        assertLe(gate.spentToday(CID, ASSET), DAILY);
        assertLe(handler.maxSingleAuthorized(), MAX);
    }

    /// Once the owner revokes the mandate, the gate never authorizes another action under it.
    function invariant_neverAuthorizedAfterRevocation() public view {
        assertEq(handler.authorizedAfterRevoke(), 0);
    }

    /// An intent the gate authorized is never authorized a second time (single-use nonces).
    function invariant_noIntentAuthorizedTwice() public view {
        assertEq(handler.replaysAccepted(), 0);
    }
}

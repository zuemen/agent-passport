// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CredentialStatusRegistry} from "../src/CredentialStatusRegistry.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";

contract CredentialStatusRegistryTest is PassportFixture {
    bytes32 internal constant CID = keccak256("vc-1");
    bytes32 internal constant ROOT = keccak256("root");

    function setUp() public {
        _deployCore();
    }

    function _anchorDefault() internal {
        vm.prank(owner);
        status.anchor(CID, agentId, ROOT, uint64(block.timestamp), uint64(block.timestamp + 1 days));
    }

    function _status() internal view returns (CredentialStatusRegistry.Status) {
        return status.statusOf(CID);
    }

    function test_anchor_isActive() public {
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.Unknown));
        _anchorDefault();
        assertTrue(status.isActive(CID));
        CredentialStatusRegistry.Credential memory c = status.getCredential(CID);
        assertEq(c.agentId, agentId);
        assertEq(c.issuer, owner);
        assertEq(c.disclosureRoot, ROOT);
    }

    function test_revert_anchor_inputs() public {
        uint64 t = uint64(block.timestamp);
        vm.startPrank(owner);
        vm.expectRevert(CredentialStatusRegistry.ZeroCredentialId.selector);
        status.anchor(bytes32(0), agentId, ROOT, t, t + 1);
        vm.expectRevert(CredentialStatusRegistry.ZeroRoot.selector);
        status.anchor(CID, agentId, bytes32(0), t, t + 1);
        vm.expectRevert(CredentialStatusRegistry.BadValidityWindow.selector);
        status.anchor(CID, agentId, ROOT, t + 5, t + 5);
        vm.expectRevert(CredentialStatusRegistry.BadValidityWindow.selector);
        status.anchor(CID, agentId, ROOT, t - 10, t);
        vm.stopPrank();
    }

    function test_revert_anchor_notOwner() public {
        // Neither the agent's own key nor an approved operator may issue its credentials.
        vm.prank(agentWallet);
        vm.expectRevert(CredentialStatusRegistry.NotAgentOwner.selector);
        status.anchor(CID, agentId, ROOT, uint64(block.timestamp), uint64(block.timestamp + 1));
    }

    function test_revert_anchor_duplicate() public {
        _anchorDefault();
        vm.prank(owner);
        vm.expectRevert(CredentialStatusRegistry.AlreadyAnchored.selector);
        status.anchor(CID, agentId, ROOT, uint64(block.timestamp), uint64(block.timestamp + 1));
    }

    function test_status_timeWindow() public {
        vm.prank(owner);
        status.anchor(CID, agentId, ROOT, uint64(block.timestamp + 100), uint64(block.timestamp + 200));
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.NotYetValid));
        vm.warp(vm.getBlockTimestamp() + 100);
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.Active));
        vm.warp(vm.getBlockTimestamp() + 100);
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.Expired));
    }

    function test_revoke_byIssuer() public {
        _anchorDefault();
        vm.expectEmit(true, true, true, true);
        emit CredentialStatusRegistry.CredentialRevoked(CID, agentId, owner, "lost-device");
        vm.prank(owner);
        status.revoke(CID, "lost-device");
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.Revoked));
    }

    function test_revert_revoke() public {
        vm.expectRevert(CredentialStatusRegistry.UnknownCredential.selector);
        status.revoke(CID, "");
        _anchorDefault();
        vm.prank(agentWallet);
        vm.expectRevert(CredentialStatusRegistry.NotIssuer.selector);
        status.revoke(CID, "");
        vm.startPrank(owner);
        status.revoke(CID, "");
        vm.expectRevert(CredentialStatusRegistry.AlreadyRevoked.selector);
        status.revoke(CID, "");
        vm.stopPrank();
    }

    function test_revokeAll_supersedesEarlierCredentials() public {
        _anchorDefault();
        vm.prank(owner);
        status.revokeAll(agentId);
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.Superseded));

        // Credentials issued after the reset are live again.
        bytes32 cid2 = keccak256("vc-2");
        vm.prank(owner);
        status.anchor(cid2, agentId, ROOT, uint64(block.timestamp), uint64(block.timestamp + 1 days));
        assertTrue(status.isActive(cid2));
    }

    function test_revert_revokeAll_notOwner() public {
        vm.expectRevert(CredentialStatusRegistry.NotAgentOwner.selector);
        status.revokeAll(agentId);
    }

    function test_transfer_invalidatesPreviousOwnersCredentials() public {
        _anchorDefault();
        address buyer = makeAddr("buyer");
        vm.prank(owner);
        identity.transferFrom(owner, buyer, agentId);
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.IssuerNotOwner));
        // Only the issuer can revoke; the new owner uses the kill switch instead.
        vm.prank(buyer);
        vm.expectRevert(CredentialStatusRegistry.NotIssuer.selector);
        status.revoke(CID, "new-owner");
        vm.prank(buyer);
        status.revokeAll(agentId);
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.Superseded));
    }

    function test_burnedOrMissingAgent_doesNotRevertStatus() public {
        _anchorDefault();
        vm.prank(owner);
        identity.transferFrom(owner, address(0xdead), agentId);
        assertEq(uint8(_status()), uint8(CredentialStatusRegistry.Status.IssuerNotOwner));
    }

    // ------------------------------------------------------------------ vLEI owner assurance

    function test_vlei_recordAndWithdraw() public {
        _anchorDefault();
        assertEq(uint8(status.ownerAssuranceOf(CID)), uint8(CredentialStatusRegistry.OwnerAssurance.NONE));
        _markVleiVerified(CID);
        assertEq(uint8(status.ownerAssuranceOf(CID)), uint8(CredentialStatusRegistry.OwnerAssurance.VLEI_VERIFIED));
        assertEq(status.getCredential(CID).vleiSaidHash, keccak256("EOOR-SAID"));

        vm.prank(vleiVerifier);
        status.recordOwnerAssurance(CID, CredentialStatusRegistry.OwnerAssurance.NONE, bytes32(0));
        assertEq(uint8(status.ownerAssuranceOf(CID)), uint8(CredentialStatusRegistry.OwnerAssurance.NONE));
    }

    function test_revert_vlei_notVerifier_unknown_zeroSaid() public {
        vm.prank(owner); // the issuer cannot vouch for itself
        vm.expectRevert(CredentialStatusRegistry.NotVleiVerifier.selector);
        status.recordOwnerAssurance(CID, CredentialStatusRegistry.OwnerAssurance.VLEI_VERIFIED, keccak256("x"));

        vm.prank(vleiVerifier);
        vm.expectRevert(CredentialStatusRegistry.UnknownCredential.selector);
        status.recordOwnerAssurance(CID, CredentialStatusRegistry.OwnerAssurance.VLEI_VERIFIED, keccak256("x"));

        _anchorDefault();
        vm.prank(vleiVerifier);
        vm.expectRevert(CredentialStatusRegistry.ZeroSaid.selector);
        status.recordOwnerAssurance(CID, CredentialStatusRegistry.OwnerAssurance.VLEI_VERIFIED, bytes32(0));
    }

    function test_revert_setVleiVerifier_onlyAdmin() public {
        vm.prank(owner);
        vm.expectRevert();
        status.setVleiVerifier(owner, true);
    }
}

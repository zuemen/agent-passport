// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {AgentIdentityRegistry} from "../src/AgentIdentityRegistry.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";

contract AgentIdentityRegistryTest is PassportFixture {
    function setUp() public {
        _deployCore();
    }

    function test_register_setsOwnerUriAndWallet() public {
        address alice = makeAddr("alice");
        vm.prank(alice);
        uint256 id = identity.register("ipfs://card");
        assertEq(identity.ownerOf(id), alice);
        assertEq(identity.tokenURI(id), "ipfs://card");
        assertEq(identity.getAgentWallet(id), alice, "registrant is the initial wallet");
        assertEq(identity.totalAgents(), 2);
    }

    function test_register_withMetadata() public {
        AgentIdentityRegistry.MetadataEntry[] memory md = new AgentIdentityRegistry.MetadataEntry[](1);
        md[0] = AgentIdentityRegistry.MetadataEntry("model", bytes("kimi-k2"));
        uint256 id = identity.register("ipfs://x", md);
        assertEq(identity.getMetadata(id, "model"), bytes("kimi-k2"));
    }

    function test_register_noArgs() public {
        uint256 id = identity.register();
        assertEq(identity.ownerOf(id), address(this));
    }

    function test_revert_register_reservedKey() public {
        AgentIdentityRegistry.MetadataEntry[] memory md = new AgentIdentityRegistry.MetadataEntry[](1);
        md[0] = AgentIdentityRegistry.MetadataEntry("agentWallet", abi.encodePacked(address(1)));
        vm.expectRevert(AgentIdentityRegistry.ReservedKey.selector);
        identity.register("ipfs://x", md);
    }

    function test_setMetadata_byOwnerAndApprovedOperator() public {
        vm.prank(owner);
        identity.setMetadata(agentId, "k", "v");
        assertEq(identity.getMetadata(agentId, "k"), bytes("v"));

        address op = makeAddr("op");
        vm.prank(owner);
        identity.setApprovalForAll(op, true);
        vm.prank(op);
        identity.setMetadata(agentId, "k", "v2");
        assertEq(identity.getMetadata(agentId, "k"), bytes("v2"));
    }

    function test_revert_setMetadata_notOperator() public {
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(AgentIdentityRegistry.NotAgentOperator.selector, mallory, agentId));
        identity.setMetadata(agentId, "k", "v");
    }

    function test_revert_setMetadata_reservedKey() public {
        vm.prank(owner);
        vm.expectRevert(AgentIdentityRegistry.ReservedKey.selector);
        identity.setMetadata(agentId, "agentWallet", abi.encodePacked(address(1)));
    }

    function test_revert_unknownAgent() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        identity.setMetadata(999, "k", "v");
    }

    function test_setAgentURI() public {
        vm.prank(owner);
        identity.setAgentURI(agentId, "ipfs://new");
        assertEq(identity.tokenURI(agentId), "ipfs://new");
    }

    function test_setAgentWallet_boundBySignature() public {
        assertEq(identity.getAgentWallet(agentId), agentWallet);
    }

    function test_revert_setAgentWallet_signatureFromWrongKey() public {
        address target = vm.addr(0xB0B);
        uint256 deadline = block.timestamp + 60;
        bytes32 digest = _identityDigest(agentId, target, owner, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest); // not target's key
        vm.prank(owner);
        vm.expectRevert(AgentIdentityRegistry.InvalidWalletSignature.selector);
        identity.setAgentWallet(agentId, target, deadline, abi.encodePacked(r, s, v));
    }

    function test_revert_setAgentWallet_deadlines() public {
        vm.startPrank(owner);
        vm.expectRevert(AgentIdentityRegistry.DeadlineExpired.selector);
        identity.setAgentWallet(agentId, agentWallet, block.timestamp - 1, "");
        vm.expectRevert(AgentIdentityRegistry.DeadlineTooFar.selector);
        identity.setAgentWallet(agentId, agentWallet, block.timestamp + 1 hours, "");
        vm.expectRevert(AgentIdentityRegistry.ZeroWallet.selector);
        identity.setAgentWallet(agentId, address(0), block.timestamp + 60, "");
        vm.stopPrank();
    }

    function test_revert_setAgentWallet_notOperator() public {
        vm.expectRevert(abi.encodeWithSelector(AgentIdentityRegistry.NotAgentOperator.selector, address(this), agentId));
        identity.setAgentWallet(agentId, agentWallet, block.timestamp + 60, "");
    }

    function test_transfer_clearsAgentWallet() public {
        vm.prank(owner);
        identity.transferFrom(owner, makeAddr("buyer"), agentId);
        assertEq(identity.getAgentWallet(agentId), address(0));
    }

    function test_unsetAgentWallet() public {
        vm.prank(owner);
        identity.unsetAgentWallet(agentId);
        assertEq(identity.getAgentWallet(agentId), address(0));
    }

    function test_isAuthorizedOrOwner() public {
        assertTrue(identity.isAuthorizedOrOwner(owner, agentId));
        assertFalse(identity.isAuthorizedOrOwner(agentWallet, agentId), "agent key is not the principal");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {PasskeyAccount, PasskeyAccountFactory} from "../src/PasskeyAccount.sol";
import {AgentIdentityRegistry} from "../src/AgentIdentityRegistry.sol";
import {CredentialStatusRegistry} from "../src/CredentialStatusRegistry.sol";
import {MockToken} from "../src/demo/MockToken.sol";
import {PassportFixture} from "./utils/PassportFixture.sol";
import {WebAuthnSigner} from "./utils/WebAuthnSigner.sol";

/// @notice The owner is a passkey: one biometric prompt registers the agent, anchors its credential
///         and approves the gate; another revokes it. Verified via the P-256 path of OZ WebAuthn.
contract PasskeyAccountTest is PassportFixture {
    uint256 internal constant PASSKEY = 0xFACE1D;
    PasskeyAccountFactory internal factory;
    PasskeyAccount internal account;
    MockToken internal usdc;

    function setUp() public {
        _deployCore();
        usdc = new MockToken("Mock USD", "mUSD", 6);
        factory = new PasskeyAccountFactory();
        (bytes32 qx, bytes32 qy) = WebAuthnSigner.publicKey(PASSKEY);
        account = factory.create(qx, qy, bytes32(0));
    }

    function _exec(PasskeyAccount.Call[] memory calls, uint256 key) internal {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 digest = account.executeDigest(calls, account.nonce(), deadline);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(key, digest);
        vm.prank(makeAddr("any-relayer"));
        account.execute(calls, deadline, auth);
    }

    function test_factory_isDeterministic() public {
        (bytes32 qx, bytes32 qy) = WebAuthnSigner.publicKey(PASSKEY);
        assertEq(factory.predict(qx, qy, bytes32(0)), address(account));
        assertEq(address(factory.create(qx, qy, bytes32(0))), address(account), "idempotent");
    }

    function test_onePrompt_registerAnchorApprove_thenRevoke() public {
        uint256 newId = identity.totalAgents() + 1;
        bytes32 cid = keccak256("vc-passkey");
        _defaultClaims(address(usdc), 100e6, 250e6, address(this));
        bytes32 root = _root();

        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](3);
        calls[0] = PasskeyAccount.Call(address(identity), 0, abi.encodeWithSignature("register(string)", "ipfs://card"));
        calls[1] = PasskeyAccount.Call(
            address(status),
            0,
            abi.encodeCall(
                CredentialStatusRegistry.anchor,
                (cid, newId, root, uint64(block.timestamp), uint64(block.timestamp + 1 days))
            )
        );
        calls[2] = PasskeyAccount.Call(address(usdc), 0, abi.encodeCall(usdc.approve, (address(gate), 500e6)));
        _exec(calls, PASSKEY);

        assertEq(identity.ownerOf(newId), address(account));
        assertTrue(status.isActive(cid));
        assertEq(usdc.allowance(address(account), address(gate)), 500e6);
        assertEq(account.nonce(), 1);

        PasskeyAccount.Call[] memory revoke = new PasskeyAccount.Call[](1);
        revoke[0] = PasskeyAccount.Call(address(status), 0, abi.encodeCall(CredentialStatusRegistry.revoke, (cid, "faceid")));
        _exec(revoke, PASSKEY);
        assertEq(uint8(status.statusOf(cid)), uint8(CredentialStatusRegistry.Status.Revoked));
    }

    function test_revert_wrongPasskey() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(identity), 0, abi.encodeWithSignature("register()"));
        uint256 deadline = block.timestamp + 60;
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(0xBADBAD, account.executeDigest(calls, 0, deadline));
        vm.expectRevert(PasskeyAccount.InvalidPasskeySignature.selector);
        account.execute(calls, deadline, auth);
    }

    function test_revert_replayAndDeadline() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(identity), 0, abi.encodeWithSignature("register()"));
        uint256 deadline = block.timestamp + 60;
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(PASSKEY, account.executeDigest(calls, 0, deadline));
        account.execute(calls, deadline, auth);
        vm.expectRevert(PasskeyAccount.InvalidPasskeySignature.selector); // nonce moved on
        account.execute(calls, deadline, auth);

        vm.warp(vm.getBlockTimestamp() + 61);
        vm.expectRevert(PasskeyAccount.DeadlineExpired.selector);
        account.execute(calls, deadline, auth);
    }

    function test_revert_tamperedCalls() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(usdc), 0, abi.encodeCall(usdc.approve, (address(gate), 1)));
        uint256 deadline = block.timestamp + 60;
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(PASSKEY, account.executeDigest(calls, 0, deadline));
        calls[0].data = abi.encodeCall(usdc.approve, (makeAddr("thief"), type(uint256).max));
        vm.expectRevert(PasskeyAccount.InvalidPasskeySignature.selector);
        account.execute(calls, deadline, auth);
    }

    function test_revert_innerCallFailureBubbles() public {
        PasskeyAccount.Call[] memory calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(
            address(status), 0, abi.encodeCall(CredentialStatusRegistry.revoke, (keccak256("none"), bytes32(0)))
        );
        uint256 deadline = block.timestamp + 60;
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(PASSKEY, account.executeDigest(calls, 0, deadline));
        vm.expectRevert(
            abi.encodeWithSelector(
                PasskeyAccount.CallFailed.selector,
                0,
                abi.encodeWithSelector(CredentialStatusRegistry.UnknownCredential.selector)
            )
        );
        account.execute(calls, deadline, auth);
    }

    function test_erc1271() public view {
        bytes32 h = keccak256("hello");
        bytes memory sig = abi.encode(WebAuthnSigner.sign(PASSKEY, h));
        assertEq(account.isValidSignature(h, sig), PasskeyAccount.isValidSignature.selector);
        bytes memory bad = abi.encode(WebAuthnSigner.sign(0xBADBAD, h));
        assertEq(account.isValidSignature(h, bad), bytes4(0xffffffff));
    }

    function test_passkeyAccountAsAgentWallet_viaErc1271() public {
        // The agent key itself may also be a passkey account (ERC-1271 path in setAgentWallet).
        uint256 deadline = block.timestamp + 60;
        bytes32 digest = _identityDigest(agentId, address(account), owner, deadline);
        bytes memory sig = abi.encode(WebAuthnSigner.sign(PASSKEY, digest));
        vm.prank(owner);
        identity.setAgentWallet(agentId, address(account), deadline, sig);
        assertEq(identity.getAgentWallet(agentId), address(account));
        // silence unused import warning
        AgentIdentityRegistry(address(identity));
    }
}

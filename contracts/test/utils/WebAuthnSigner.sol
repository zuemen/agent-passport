// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @dev Produces WebAuthn assertions the way a browser authenticator would (type "webauthn.get",
///      base64url challenge, UP+UV flags), signed with a Foundry-held P-256 key.
library WebAuthnSigner {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    function publicKey(uint256 pk) internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        return (bytes32(x), bytes32(y));
    }

    function sign(uint256 pk, bytes32 challenge) internal pure returns (WebAuthn.WebAuthnAuth memory auth) {
        string memory prefix = '{"type":"webauthn.get","challenge":"';
        auth.clientDataJSON = string.concat(
            prefix, Base64.encodeURL(abi.encodePacked(challenge)), '","origin":"https://agent-passport.app"}'
        );
        auth.typeIndex = 1;
        auth.challengeIndex = 23; // position of "challenge":" in the JSON above
        // rpIdHash ‖ flags (UP=0x01 | UV=0x04) ‖ signCount
        auth.authenticatorData = abi.encodePacked(sha256("agent-passport.app"), bytes1(0x05), uint32(1));

        bytes32 h = sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, h);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s)); // authenticators may emit high-s; normalise
        auth.r = r;
        auth.s = s;
    }
}

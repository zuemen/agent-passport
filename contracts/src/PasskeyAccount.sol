// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @title PasskeyAccount
/// @notice A minimal smart account controlled by a WebAuthn passkey (Face ID / Touch ID / Android
///         biometrics) instead of a seed phrase. It is the *owner* in Agent Passport: it owns the
///         agent NFT, issues and revokes credentials, and holds the funds the agent spends.
///
///         Signatures are verified on-chain with OpenZeppelin's WebAuthn library, which uses the
///         P-256 precompile at 0x0100 (EIP-7951) available on Monad. Anyone can relay an `execute`
///         call — the passkey signature is the authorization, so the owner never needs gas or a
///         second wallet. One biometric prompt can batch "register agent + issue credential +
///         approve the gate".
contract PasskeyAccount is EIP712, IERC1271, IERC721Receiver {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    bytes32 public constant CALL_TYPEHASH = keccak256("Call(address target,uint256 value,bytes data)");
    bytes32 public constant EXECUTE_TYPEHASH = keccak256(
        "Execute(Call[] calls,uint256 nonce,uint256 deadline)Call(address target,uint256 value,bytes data)"
    );

    /// Passkey public key (P-256 affine coordinates).
    bytes32 public immutable qx;
    bytes32 public immutable qy;
    uint256 public nonce;

    event Executed(uint256 indexed nonce, uint256 calls);

    error DeadlineExpired();
    error InvalidPasskeySignature();
    error CallFailed(uint256 index, bytes reason);

    constructor(bytes32 qx_, bytes32 qy_) EIP712("AgentPassportPasskeyAccount", "1") {
        qx = qx_;
        qy = qy_;
    }

    receive() external payable {}

    /// @notice Execute `calls` if the passkey signed them (as the WebAuthn challenge).
    function execute(Call[] calldata calls, uint256 deadline, WebAuthn.WebAuthnAuth calldata auth)
        external
        payable
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        uint256 n = nonce;
        bytes32 digest = executeDigest(calls, n, deadline);
        if (!WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy)) revert InvalidPasskeySignature();

        nonce = n + 1; // effects before any interaction
        emit Executed(n, calls.length);

        // Batch of owner-signed calls: sending value to, and calling, arbitrary targets is the purpose.
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
    }

    /// @notice The EIP-712 digest the passkey must sign (used verbatim as the WebAuthn challenge).
    function executeDigest(Call[] calldata calls, uint256 nonce_, uint256 deadline) public view returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            callHashes[i] =
                keccak256(abi.encode(CALL_TYPEHASH, calls[i].target, calls[i].value, keccak256(calls[i].data)));
        }
        return _hashTypedDataV4(
            keccak256(abi.encode(EXECUTE_TYPEHASH, keccak256(abi.encodePacked(callHashes)), nonce_, deadline))
        );
    }

    /// @notice ERC-1271: `signature` is an ABI-encoded `WebAuthn.WebAuthnAuth` over `hash`.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        WebAuthn.WebAuthnAuth memory auth = abi.decode(signature, (WebAuthn.WebAuthnAuth));
        return WebAuthn.verify(abi.encodePacked(hash), auth, qx, qy) ? this.isValidSignature.selector : bytes4(0xffffffff);
    }

    /// @dev The official ERC-8004 Identity Registry mints with `_safeMint`.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @title PasskeyAccountFactory
/// @notice Deterministic (CREATE2) deployment, so the account address is known before the first use.
contract PasskeyAccountFactory {
    event AccountCreated(address indexed account, bytes32 qx, bytes32 qy);

    function create(bytes32 qx, bytes32 qy, bytes32 salt) external returns (PasskeyAccount account) {
        address predicted = predict(qx, qy, salt);
        if (predicted.code.length != 0) return PasskeyAccount(payable(predicted));
        account = new PasskeyAccount{salt: salt}(qx, qy);
        emit AccountCreated(address(account), qx, qy);
    }

    function predict(bytes32 qx, bytes32 qy, bytes32 salt) public view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(PasskeyAccount).creationCode, abi.encode(qx, qy)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }
}

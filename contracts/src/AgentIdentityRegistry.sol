// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";

/// @title AgentIdentityRegistry
/// @notice ERC-8004 ("Trustless Agents") Identity Registry. Each agent is an ERC-721 token; the token
///         owner is the principal accountable for the agent, and `agentWallet` is the key the agent
///         itself transacts with.
/// @dev Interface follows ERC-8004 (Draft, 2026-01-25 revision). Implemented from the spec for this
///      project; not a copy of the upgradeable reference deployment.
contract AgentIdentityRegistry is ERC721URIStorage, EIP712, IAgentIdentity {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    /// @dev ERC-8004 reserved key. Only changeable through `setAgentWallet` with a signature from the
    ///      new wallet, so an owner cannot point its agent at an address it does not control.
    string public constant AGENT_WALLET_KEY = "agentWallet";
    bytes32 private constant AGENT_WALLET_KEY_HASH = keccak256("agentWallet");

    bytes32 public constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");

    uint256 public constant MAX_DEADLINE_DELAY = 5 minutes;

    uint256 private _nextId = 1;
    mapping(uint256 agentId => mapping(string key => bytes value)) private _metadata;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    error NotAgentOperator(address caller, uint256 agentId);
    error ReservedKey();
    error ZeroWallet();
    error DeadlineExpired();
    error DeadlineTooFar();
    error InvalidWalletSignature();

    constructor() ERC721("Agent Passport Identity", "AGENT") EIP712("AgentPassportIdentity", "1") {}

    modifier onlyAgentOperator(uint256 agentId) {
        address owner = ownerOf(agentId); // reverts for unknown agents
        if (!_isAuthorized(owner, msg.sender, agentId)) revert NotAgentOperator(msg.sender, agentId);
        _;
    }

    // ------------------------------------------------------------------ registration

    function register() external returns (uint256 agentId) {
        agentId = _register("");
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _register(agentURI);
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        for (uint256 i; i < metadata.length; ++i) {
            if (keccak256(bytes(metadata[i].metadataKey)) == AGENT_WALLET_KEY_HASH) revert ReservedKey();
        }
        agentId = _register(agentURI);
        for (uint256 i; i < metadata.length; ++i) {
            _metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function _register(string memory agentURI) private returns (uint256 agentId) {
        agentId = _nextId++;
        // The registrant's address is the initial agent wallet, as in ERC-8004.
        _metadata[agentId][AGENT_WALLET_KEY] = abi.encodePacked(msg.sender);
        // _mint (not _safeMint): no callback into the registrant while state is half-written.
        _mint(msg.sender, agentId);
        if (bytes(agentURI).length != 0) _setTokenURI(agentId, agentURI);
        emit Registered(agentId, agentURI, msg.sender);
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encodePacked(msg.sender));
    }

    // ------------------------------------------------------------------ metadata

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue)
        external
        onlyAgentOperator(agentId)
    {
        if (keccak256(bytes(metadataKey)) == AGENT_WALLET_KEY_HASH) revert ReservedKey();
        _metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external onlyAgentOperator(agentId) {
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    // ------------------------------------------------------------------ agent wallet

    function getAgentWallet(uint256 agentId) public view returns (address) {
        bytes memory raw = _metadata[agentId][AGENT_WALLET_KEY];
        if (raw.length != 20) return address(0);
        // forge-lint: disable-next-line(unsafe-typecast) -- length checked to be exactly 20 bytes
        return address(bytes20(raw));
    }

    /// @notice Bind `newWallet` as the agent's transacting key. `signature` must come from `newWallet`
    ///         (ECDSA for EOAs / EIP-7702 accounts, ERC-1271 for contract wallets).
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
        onlyAgentOperator(agentId)
    {
        if (newWallet == address(0)) revert ZeroWallet();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (deadline > block.timestamp + MAX_DEADLINE_DELAY) revert DeadlineTooFar();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, newWallet, ownerOf(agentId), deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature)) revert InvalidWalletSignature();

        _metadata[agentId][AGENT_WALLET_KEY] = abi.encodePacked(newWallet);
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, abi.encodePacked(newWallet));
    }

    function unsetAgentWallet(uint256 agentId) external onlyAgentOperator(agentId) {
        delete _metadata[agentId][AGENT_WALLET_KEY];
        emit MetadataSet(agentId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, "");
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        return _isAuthorized(ownerOf(agentId), spender, agentId);
    }

    function ownerOf(uint256 agentId) public view override(ERC721, IERC721, IAgentIdentity) returns (address) {
        return super.ownerOf(agentId);
    }

    // ------------------------------------------------------------------ transfer hook

    /// @dev A transferred agent must not keep the previous owner's wallet binding.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _metadata[tokenId][AGENT_WALLET_KEY].length != 0) {
            delete _metadata[tokenId][AGENT_WALLET_KEY];
            emit MetadataSet(tokenId, AGENT_WALLET_KEY, AGENT_WALLET_KEY, "");
        }
        return super._update(to, tokenId, auth);
    }

    function totalAgents() external view returns (uint256) {
        return _nextId - 1;
    }
}

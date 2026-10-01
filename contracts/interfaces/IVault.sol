// SPDX-License-Identifier: MIT
// Read surface and call encoder for the live Vault.
// This file does not deploy or modify Vault. The live bytecode stays where it is:
// deployments/base-sepolia.json (Base Sepolia, owner = CORE_TIMELOCK).

pragma solidity ^0.8.20;

/// @title IVault
/// @notice ABI hook for wallets and relayers talking to the live Vault.
/// @dev Matches `contracts/Vault.sol` as deployed. `Tier` ordinals are ABI. Do not reorder:
///      `None = 0`, `Chat = 1`, `DataTools = 2`, `Financial = 3`, `Critical = 4`.
///      `grantAccess` is a view. The live contract declares `AccessGranted` and does not emit it.
///      `register` fails closed unless `denylist.check` is `None`.
///      Writes are `onlyOwner`. On the live pair that owner is CORE_TIMELOCK.
///      Ownable2Step ownership calls stay on the contract. This hook is the bot surface:
///      register, operator, burn, grant, and the public reads.
interface IVault {
    enum Tier {
        None,
        Chat,
        DataTools,
        Financial,
        Critical
    }

    event Registered(bytes32 indexed botId, Tier tier, uint256 ts);
    event Burned(bytes32 indexed botId, uint256 ts);
    event AccessGranted(bytes32 indexed botId, Tier tier, uint256 ts);
    event OperatorSet(bytes32 indexed botId, address indexed account);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);

    /// @notice Denylist this vault reads inside `register`. Live value is the live Denylist.
    function denylist() external view returns (address);

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);

    function bots(
        bytes32 botId
    )
        external
        view
        returns (
            bytes32 weightHash,
            bytes32 behaviorSig,
            bytes32 promptHash,
            Tier tier,
            bool active,
            uint256 registeredAt
        );

    function operator(
        bytes32 botId
    ) external view returns (address);

    function tierMaxPermissions(
        Tier tier
    ) external view returns (uint8);

    /// @notice Register a bot. Reverts `bot is denylisted` when `check` is not `None`.
    /// @dev Does not set `operator`.
    function register(
        bytes32 botId,
        bytes32 weightHash,
        bytes32 behaviorSig,
        bytes32 promptHash,
        Tier tier
    ) external;

    /// @notice Register a bot and bind its operator in the same transaction.
    /// @dev Reverts `zero operator` before the bot is stored. Reverts `already registered`
    ///      when `registeredAt != 0`, including after `burn`.
    function register(
        bytes32 botId,
        bytes32 weightHash,
        bytes32 behaviorSig,
        bytes32 promptHash,
        Tier tier,
        address operator_
    ) external;

    /// @notice Bind or rotate the operator. Reverts `unknown bot` when `registeredAt == 0`.
    function setOperator(
        bytes32 botId,
        address account
    ) external;

    /// @notice True when `requestedPerms` is within the active bot's tier cap.
    /// @dev Reverts `bot not active` when the bot is missing or burned. No attestation read.
    function grantAccess(
        bytes32 botId,
        uint8 requestedPerms
    ) external view returns (bool);

    /// @notice Clear `active`. The same `botId` cannot be registered again.
    function burn(
        bytes32 botId
    ) external;
}

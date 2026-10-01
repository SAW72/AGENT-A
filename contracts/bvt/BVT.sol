// SPDX-License-Identifier: MIT
// Agent A Token (BVT) — ERC-20. No constructor premine. Mint only via
// protocol earn (FeeRouter) or operator stake bootstrap (Staking).
// On-chain ERC-20 name() remains "Bot Verifier Token"; symbol remains BVT.
// Not audited. For illustration and local testing.
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Agent A Token (BVT)
/// @notice Usage / operator-stake token for Agent A (Agent Auditor).
///         On-chain ERC-20 name is "Bot Verifier Token"; symbol is BVT.
///         There is no public sale allocation.
contract BVT is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant LOCKER_ROLE = keccak256("LOCKER_ROLE");

    /// @notice Tokens locked as auditor/operator stake. Not transferable.
    mapping(address => uint256) public locked;

    event Locked(address indexed account, uint256 amount);
    event Unlocked(address indexed account, uint256 amount);
    event LockedBurned(address indexed account, uint256 amount);

    constructor(
        address admin
    ) ERC20("Bot Verifier Token", "BVT") {
        require(admin != address(0), "BVT: admin zero");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // Intentionally no _mint. Supply starts at 0.
    }

    /// @notice Unlocked (transferable) balance.
    function unlockedOf(
        address account
    ) public view returns (uint256) {
        return balanceOf(account) - locked[account];
    }

    function mint(
        address to,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) {
        require(to != address(0), "BVT: mint zero");
        require(amount > 0, "BVT: amount zero");
        _mint(to, amount);
    }

    function lock(
        address account,
        uint256 amount
    ) external onlyRole(LOCKER_ROLE) {
        require(unlockedOf(account) >= amount, "BVT: insufficient unlocked");
        locked[account] += amount;
        emit Locked(account, amount);
    }

    function unlock(
        address account,
        uint256 amount
    ) external onlyRole(LOCKER_ROLE) {
        require(locked[account] >= amount, "BVT: unlock exceeds locked");
        locked[account] -= amount;
        emit Unlocked(account, amount);
    }

    /// @notice Slash burn: reduce locked, then burn. Skips the transfer lock check.
    function burnLocked(
        address account,
        uint256 amount
    ) external onlyRole(LOCKER_ROLE) {
        require(locked[account] >= amount, "BVT: burn exceeds locked");
        locked[account] -= amount;
        _burn(account, amount);
        emit LockedBurned(account, amount);
    }

    /// @notice Move locked tokens to another address still locked (slash → sink).
    function moveLocked(
        address from,
        address to,
        uint256 amount
    ) external onlyRole(LOCKER_ROLE) {
        require(to != address(0), "BVT: move zero");
        require(locked[from] >= amount, "BVT: move exceeds locked");
        locked[from] -= amount;
        _burn(from, amount);
        _mint(to, amount);
        locked[to] += amount;
        emit LockedBurned(from, amount);
        emit Locked(to, amount);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        // Transfers (not mint/burn) may only move unlocked tokens.
        if (from != address(0) && to != address(0) && value > 0) {
            require(unlockedOf(from) >= value, "BVT: insufficient unlocked");
        }
        super._update(from, to, value);
    }
}

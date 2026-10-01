// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { console } from "forge-std/Script.sol";
import { Vault } from "../contracts/Vault.sol";
import { OpsLive } from "./OpsLive.sol";

abstract contract OpsVaultLog is OpsLive {
    function _loadRegistration()
        internal
        view
        returns (
            Vault vault,
            address timelock,
            bytes32 botId,
            bytes32 weight,
            bytes32 sig,
            bytes32 prompt,
            Vault.Tier tier
        )
    {
        (vault, timelock) = loadVault();
        botId = readBytes32("BOT_ID", "OpsLive: BOT_ID unset");
        weight = readBytes32("WEIGHT_HASH", "OpsLive: WEIGHT_HASH unset");
        sig = readBytes32("BEHAVIOR_SIG", "OpsLive: BEHAVIOR_SIG unset");
        prompt = readBytes32("PROMPT_HASH", "OpsLive: PROMPT_HASH unset");
        tier = parseTier(readString("TIER", "OpsLive: TIER unset"));
    }

    function _logVault(
        string memory op,
        Vault vault,
        address timelock,
        bytes32 botId,
        Vault.Tier tier,
        address operator_
    ) internal view {
        console.log("op", op);
        console.log("chainid", block.chainid);
        console.log("Vault", address(vault));
        console.log("denylist", address(vault.denylist()));
        console.log("CORE_TIMELOCK", timelock);
        console.log("tier", uint256(tier));
        console.log("operator", operator_);
        console.logBytes32(botId);
    }

    function _logBot(
        Vault vault,
        bytes32 botId
    ) internal view {
        (,,,, bool active, uint256 registeredAt) = vault.bots(botId);
        console.log("active", active);
        console.log("registeredAt", registeredAt);
        console.log("operator", vault.operator(botId));
    }
}

/// @notice Five-arg `Vault.register`. Leaves `operator` unset.
/// @dev Simulate: `forge script script/OpsVault.s.sol:OpsVaultRegister --rpc-url $BASE_SEPOLIA_RPC_URL`
///      Agents must not pass `--broadcast`. See script/OPS_LIVE_DENYLIST_VAULT.md.
contract OpsVaultRegister is OpsVaultLog {
    function run() external {
        requireAllowedChain();
        (Vault vault, address timelock, bytes32 botId, bytes32 weight, bytes32 sig, bytes32 prompt, Vault.Tier tier) =
            _loadRegistration();
        _logVault("register", vault, timelock, botId, tier, address(0));
        bool send = asOwner(timelock);
        vault.register(botId, weight, sig, prompt, tier);
        finishOwner(send);
        _logBot(vault, botId);
    }
}

/// @notice Six-arg `Vault.register`. Binds `operator` in the same call.
/// @dev Env `OPERATOR` must be non-zero. A zero operator reverts inside Vault and the bot is not stored.
contract OpsVaultRegisterWithOperator is OpsVaultLog {
    function run() external {
        requireAllowedChain();
        (Vault vault, address timelock, bytes32 botId, bytes32 weight, bytes32 sig, bytes32 prompt, Vault.Tier tier) =
            _loadRegistration();
        address operator_ = readAddress("OPERATOR", "OpsLive: OPERATOR unset");
        _logVault("registerWithOperator", vault, timelock, botId, tier, operator_);
        bool send = asOwner(timelock);
        vault.register(botId, weight, sig, prompt, tier, operator_);
        finishOwner(send);
        _logBot(vault, botId);
    }
}

/// @notice `Vault.burn` on the live Base Sepolia vault. Irreversible for that `botId`.
contract OpsVaultBurn is OpsVaultLog {
    function run() external {
        requireAllowedChain();
        (Vault vault, address timelock) = loadVault();
        bytes32 botId = readBytes32("BOT_ID", "OpsLive: BOT_ID unset");
        console.log("op burn");
        console.log("chainid", block.chainid);
        console.log("Vault", address(vault));
        console.log("CORE_TIMELOCK", timelock);
        console.logBytes32(botId);
        bool send = asOwner(timelock);
        vault.burn(botId);
        finishOwner(send);
        _logBot(vault, botId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { BotAttestationEscrow } from "../contracts/BotAttestationEscrow.sol";

/// @notice Escrow-only deploy of BotAttestationEscrow against the live Base Sepolia stack.
/// Does not deploy Denylist, Vault, or DisputePanel. `run` accepts only the live addresses.
/// `governance` is `NEW_TIMELOCK` from the environment. There is no default.
/// After deploy: `transferOwnership(NEW_TIMELOCK)` (Ownable2Step). That account must call
/// `acceptOwnership`. `createEscrow` and dependency swaps revert until it has accepted, and
/// swaps also revert while ETH is locked (`lockedValue != 0`).
/// Do not fund before accept. There is no production hot key for `setDenylist`.
/// Chain ids 84532 (Base Sepolia) and 31337 (Anvil) proceed. Every other chain reverts.
/// Mainnet is always refused.
/// Dry-run keeps working with `--sender` set to `SIMULATE_SENDER` and no account.
/// Broadcast uses a Foundry keystore: `forge` sets `msg.sender` from `--account`
/// and `--sender`, and `run` calls `vm.startBroadcast()` with no key argument.
/// The default Foundry sender and `SIMULATE_SENDER` revert on broadcast.
/// Agents do not --broadcast. Spencer runs the broadcast command locally, after
/// the Auditor re-audit passes and the Verifier approves.
contract DeployBotAttestationEscrow is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ANVIL_CHAIN_ID = 31337;
    uint256 public constant ETH_SEPOLIA_CHAIN_ID = 11155111;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;
    uint256 public constant ALLOWED_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

    address public constant LIVE_DENYLIST = 0xeE76876bECcFc1B58fC06fF4E654a517d784B224;
    address public constant LIVE_VAULT = 0x1463D664fA467FBCDA4B05443434494f05e565bc;
    address public constant LIVE_DISPUTE_PANEL = 0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb;
    /// @dev Pre-migration owner. Not the constructor `governance` value. That comes from `NEW_TIMELOCK`.
    address public constant LIVE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;

    /// @dev Dry-run sender only. Not a key and not CORE_TIMELOCK.
    ///      Forge checks this account's real balance while estimating gas. This is the
    ///      public burn EOA, which already holds dust on Base Sepolia. Spencer's
    ///      broadcast uses a different deployer account from the keystore.
    address public constant SIMULATE_SENDER = 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001;

    /// @dev Foundry's sender when `--sender` / `--account` is omitted.
    ///      `forge-std` `DEFAULT_SENDER`. Broadcast must not use it.
    address public constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    function requireAllowedChain() public view {
        if (block.chainid == ETH_MAINNET_CHAIN_ID) {
            revert("DeployEscrow: mainnet forbidden");
        }
        if (block.chainid != ALLOWED_CHAIN_ID && block.chainid != ANVIL_CHAIN_ID) {
            revert("DeployEscrow: Base Sepolia (84532) or Anvil (31337) only");
        }
    }

    function requireTimelock(
        address deployer,
        address timelock
    ) public pure {
        if (timelock == address(0)) revert("DeployEscrow: NEW_TIMELOCK unset");
        if (timelock == deployer) revert("DeployEscrow: NEW_TIMELOCK must not be deployer");
    }

    function requireDeps(
        address denylist,
        address vault,
        address panel
    ) public pure {
        if (denylist == address(0)) revert("DeployEscrow: DENYLIST unset");
        if (vault == address(0)) revert("DeployEscrow: VAULT unset");
        if (panel == address(0)) revert("DeployEscrow: DISPUTE_PANEL unset");
    }

    /// @notice `run` deploys only against the live Denylist, Vault, and DisputePanel.
    function requireLiveStack(
        address denylist,
        address vault,
        address panel
    ) public pure {
        if (denylist != LIVE_DENYLIST) revert("DeployEscrow: DENYLIST is not the live Base Sepolia Denylist");
        if (vault != LIVE_VAULT) revert("DeployEscrow: VAULT is not the live Base Sepolia Vault");
        if (panel != LIVE_DISPUTE_PANEL) {
            revert("DeployEscrow: DISPUTE_PANEL is not the live Base Sepolia DisputePanel");
        }
    }

    function broadcasting() public view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    /// @notice Broadcast must name a keystore account and its address.
    ///         The default Foundry sender and the dry-run burn address are refused.
    ///         `run` calls this only when `broadcasting()` is true. `forge test` cannot
    ///         enter `ScriptBroadcast`, so the unit test calls this function directly.
    function requireBroadcastSender(
        address deployer
    ) public pure {
        if (deployer == FOUNDRY_DEFAULT_SENDER || deployer == SIMULATE_SENDER) {
            revert("DeployEscrow: pass --account and --sender");
        }
    }

    function readAddress(
        string memory key,
        string memory unsetErr
    ) public view returns (address a) {
        try vm.envAddress(key) returns (address set) {
            a = set;
        } catch {
            revert(unsetErr);
        }
        if (a == address(0)) revert(unsetErr);
    }

    /// @notice Deploy and `transferOwnership` to `timelock`. Used by `run` and by tests (no broadcast).
    function deploy(
        address denylist,
        address vault,
        address panel,
        address timelock
    ) public returns (BotAttestationEscrow escrow) {
        requireDeps(denylist, vault, panel);
        escrow = new BotAttestationEscrow(denylist, vault, panel, timelock);
        escrow.transferOwnership(timelock);
    }

    function run() external {
        requireAllowedChain();

        address timelock = readAddress("NEW_TIMELOCK", "DeployEscrow: NEW_TIMELOCK unset");
        address denylist = readAddress("DENYLIST", "DeployEscrow: DENYLIST unset");
        address vault = readAddress("VAULT", "DeployEscrow: VAULT unset");
        address panel = readAddress("DISPUTE_PANEL", "DeployEscrow: DISPUTE_PANEL unset");
        requireDeps(denylist, vault, panel);
        requireLiveStack(denylist, vault, panel);

        address deployer = msg.sender;
        requireTimelock(deployer, timelock);
        if (broadcasting()) {
            requireBroadcastSender(deployer);
            console.log("BROADCAST Spencer-only");
        } else {
            console.log("SIMULATE; no transaction will be sent");
        }
        vm.startBroadcast();

        BotAttestationEscrow escrow = deploy(denylist, vault, panel, timelock);
        vm.stopBroadcast();

        console.log("chainid", block.chainid);
        console.log("deployer", deployer);
        console.log("BotAttestationEscrow", address(escrow));
        console.log("constructor Denylist", denylist);
        console.log("constructor Vault", vault);
        console.log("constructor DisputePanel", panel);
        console.log("constructor governance", timelock);
        console.log("owner", escrow.owner());
        console.log("pendingOwner", escrow.pendingOwner());
        console.log("Do not write this address into deployments/base-sepolia.json.");
        console.log("Wiring is a separate PR after a human broadcast.");
        console.log("Agents must not --broadcast.");
    }
}

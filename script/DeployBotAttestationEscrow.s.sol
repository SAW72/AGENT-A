// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { BotAttestationEscrow } from "../contracts/BotAttestationEscrow.sol";
import { MigrateOwnershipToTimelock } from "./MigrateOwnershipToTimelock.s.sol";

/// @notice Escrow-only deploy of BotAttestationEscrow against the live Base Sepolia stack.
/// Does not deploy Denylist, Vault, or DisputePanel. `run` accepts only the live addresses.
/// Immutable `governance` is `NEW_TIMELOCK`. There is no default. It must be exactly one of
/// `LIVE_TIMELOCK` (pre-migration CORE) or a `TimelockController` that passes
/// `MigrateOwnershipToTimelock.requireValidTimelock` (code, `getMinDelay() >= 300`,
/// `EXPECTED_TIMELOCK`, the deploy-record role grants, the Safe checks, and no CORE roles).
/// When `governanceTimelock` in the book is set, the timelock path must equal that address.
/// After deploy: `transferOwnership` to that same address (Ownable2Step). That account must call
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
    /// @dev Pre-migration CORE owner. Allowed as constructor `governance` until the timelock path is used.
    address public constant LIVE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;

    /// @dev Test-only. Broadcast uses a fresh `MigrateOwnershipToTimelock` and the real book.
    MigrateOwnershipToTimelock internal pinnedChecker;
    bool internal bookPinned;
    string internal pinnedBookPath;

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

    /// @notice Test-only checker. Broadcast builds `MigrateOwnershipToTimelock` itself.
    function useTimelockCheck(
        MigrateOwnershipToTimelock checker
    ) external {
        if (broadcasting()) revert("DeployEscrow: timelock check reads the chain");
        pinnedChecker = checker;
    }

    /// @notice Test-only book path. Broadcast reads `deployments/base-sepolia.json`.
    function useBook(
        string calldata path
    ) external {
        if (broadcasting()) revert("DeployEscrow: book is deployments/base-sepolia.json");
        pinnedBookPath = path;
        bookPinned = true;
    }

    /// @notice `governance` is pre-migration CORE, or a controller that passes `requireValidTimelock`.
    /// @dev Anything else reverts before the escrow is created. `EXPECTED_TIMELOCK` has no default.
    ///      A set `governanceTimelock` in the book must equal the controller.
    function requireGovernance(
        address deployer,
        address timelock
    ) public {
        requireAllowedChain();
        requireTimelock(deployer, timelock);
        if (timelock == LIVE_TIMELOCK) {
            console.log("pre-migration/legacy: governance is CORE_TIMELOCK");
            return;
        }
        if (timelock.code.length == 0) revert("MigrateOwnership: NEW_TIMELOCK has no code");
        MigrateOwnershipToTimelock checker = _timelockChecker();
        uint256 delay;
        try TimelockController(payable(timelock)).getMinDelay() returns (uint256 got) {
            delay = got;
        } catch {
            revert("MigrateOwnership: NEW_TIMELOCK getMinDelay failed");
        }
        if (delay < checker.minDelayFloor()) revert("MigrateOwnership: minDelay below floor");
        checker.requireValidTimelock(timelock);
        _requireBookGovernance(timelock);
    }

    /// @notice Book `governanceTimelock` when it is a real address. Null, missing, and zero are unset.
    function readBookGovernance() public view returns (address governance, bool set) {
        string memory json = vm.readFile(_bookPath());
        if (!vm.keyExistsJson(json, ".governanceTimelock")) return (address(0), false);
        try vm.parseJsonAddress(json, ".governanceTimelock") returns (address parsed) {
            if (parsed == address(0)) return (address(0), false);
            return (parsed, true);
        } catch { }
        try vm.parseJsonString(json, ".governanceTimelock") returns (string memory text) {
            // Foundry returns the word null for a JSON null. That field is unset until Spencer fills it.
            if (bytes(text).length == 0 || keccak256(bytes(text)) == keccak256("null")) return (address(0), false);
            revert("DeployEscrow: governanceTimelock is not an address");
        } catch {
            return (address(0), false);
        }
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
    /// @dev `requireGovernance` runs before the create. A bad `NEW_TIMELOCK` never becomes immutable `governance`.
    function deploy(
        address denylist,
        address vault,
        address panel,
        address timelock
    ) public returns (BotAttestationEscrow escrow) {
        requireDeps(denylist, vault, panel);
        requireGovernance(msg.sender, timelock);
        escrow = _create(denylist, vault, panel, timelock);
    }

    function _create(
        address denylist,
        address vault,
        address panel,
        address timelock
    ) internal returns (BotAttestationEscrow escrow) {
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
        requireGovernance(deployer, timelock);
        if (broadcasting()) {
            requireBroadcastSender(deployer);
            console.log("BROADCAST Spencer-only");
        } else {
            console.log("SIMULATE; no transaction will be sent");
        }
        vm.startBroadcast();

        BotAttestationEscrow escrow = _create(denylist, vault, panel, timelock);
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

    function _timelockChecker() internal returns (MigrateOwnershipToTimelock checker) {
        if (address(pinnedChecker) != address(0)) return pinnedChecker;
        checker = new MigrateOwnershipToTimelock();
        pinnedChecker = checker;
    }

    function _bookPath() internal view returns (string memory path) {
        if (bookPinned) return pinnedBookPath;
        path = "deployments/base-sepolia.json";
    }

    function _requireBookGovernance(
        address timelock
    ) internal view {
        (address booked, bool set) = readBookGovernance();
        if (set && booked != timelock) revert("DeployEscrow: NEW_TIMELOCK is not governanceTimelock");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { BotAttestationEscrow } from "../contracts/BotAttestationEscrow.sol";
import { MigrateOwnershipToTimelock } from "./MigrateOwnershipToTimelock.s.sol";
import { OpsLive, OpsTimelockCall } from "./OpsLive.sol";

/// @notice Escrow-only deploy of BotAttestationEscrow against the live Base Sepolia stack.
/// Does not deploy Denylist, Vault, or DisputePanel. `run` accepts only the live addresses.
/// Immutable `governance` is `NEW_TIMELOCK`. There is no default. It must be a
/// `TimelockController` that passes `MigrateOwnershipToTimelock.requireValidTimelock`
/// (code that is not an EIP-7702 designator, not CORE, not the deployer, `getMinDelay() >= 300`,
/// `EXPECTED_TIMELOCK`, the deploy-record role grants, the Safe checks, and no CORE roles).
/// When `governanceTimelock` in the book is set, that address must equal `NEW_TIMELOCK`.
/// CORE is refused: a new escrow must not hand single-key governance back to that EOA.
/// After deploy: `transferOwnership` to that timelock (Ownable2Step). The script then prints
/// Safe-ready `schedule` / `execute` calldata for `acceptOwnership` on the address `new` returned.
/// Under `startBroadcast` that creator is the deployer EOA, not this script. The timelock must call
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
    /// @dev Pre-migration CORE owner. Refused as constructor `governance`.
    address public constant LIVE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;

    /// @dev Test-only. Broadcast uses a fresh `MigrateOwnershipToTimelock` and the real book.
    MigrateOwnershipToTimelock internal pinnedChecker;
    bool internal bookPinned;
    string internal pinnedBookPath;
    bool internal runInputsPinned;
    address internal pinnedRunTimelock;
    address internal pinnedRunDenylist;
    address internal pinnedRunVault;
    address internal pinnedRunPanel;
    OpsTimelockCall internal printer;
    OpsLive.TimelockCall public lastAcceptCall;

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

    /// @notice Test-only inputs for `runBroadcast`. Broadcast reads the env vars. No defaults.
    function useRunInputs(
        address timelock,
        address denylist,
        address vault,
        address panel
    ) external {
        if (broadcasting()) revert("DeployEscrow: set NEW_TIMELOCK");
        runInputsPinned = true;
        pinnedRunTimelock = timelock;
        pinnedRunDenylist = denylist;
        pinnedRunVault = vault;
        pinnedRunPanel = panel;
    }

    /// @notice `governance` must be a controller that passes `requireValidTimelock`. CORE reverts.
    /// @dev Anything else reverts before the escrow is created. `EXPECTED_TIMELOCK` has no default.
    ///      A set `governanceTimelock` in the book must equal the controller.
    function requireGovernance(
        address deployer,
        address timelock
    ) public {
        requireAllowedChain();
        requireTimelock(deployer, timelock);
        if (timelock == LIVE_TIMELOCK) revert("DeployEscrow: NEW_TIMELOCK is pre-migration CORE");
        if (timelock.code.length == 0) revert("MigrateOwnership: NEW_TIMELOCK has no code");
        MigrateOwnershipToTimelock checker = _timelockChecker();
        if (checker.isDelegation(timelock)) revert("DeployEscrow: NEW_TIMELOCK is an EIP-7702 delegation");
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
        rejectZero(a, unsetErr);
    }

    /// @notice Zero is the same failure as an unset env var.
    function rejectZero(
        address a,
        string memory unsetErr
    ) public pure {
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
        _recordAccept(timelock, address(escrow));
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
        _run(msg.sender);
    }

    /// @notice Test-only. Same steps as `run`, with `startBroadcast(deployer)` so the EOA is the creator.
    /// @dev Pins must already be set. A real script broadcast calls `run` and reads the env.
    function runBroadcast(
        address deployer
    ) external {
        if (broadcasting()) revert("DeployEscrow: runBroadcast is not a broadcast");
        _run(deployer);
    }

    /// @dev `requireGovernance` runs before `new`. Accept calldata is built from the address `new` returned.
    function _run(
        address deployer
    ) internal {
        requireAllowedChain();

        address timelock = _runTimelock();
        address denylist = _runDenylist();
        address vault = _runVault();
        address panel = _runPanel();
        requireDeps(denylist, vault, panel);
        requireLiveStack(denylist, vault, panel);

        requireGovernance(deployer, timelock);
        _printer();
        if (broadcasting()) {
            requireBroadcastSender(deployer);
            console.log("BROADCAST Spencer-only");
        } else {
            console.log("SIMULATE; no transaction will be sent");
        }
        vm.startBroadcast(deployer);

        BotAttestationEscrow escrow = _create(denylist, vault, panel, timelock);
        vm.stopBroadcast();
        _recordAccept(timelock, address(escrow));

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

    /// @dev Safe-ready `acceptOwnership` calldata for the escrow that was just created.
    function _recordAccept(
        address timelock,
        address escrow
    ) internal {
        OpsTimelockCall printer_ = _printer();
        bytes memory data = abi.encodeWithSelector(bytes4(keccak256("acceptOwnership()")));
        lastAcceptCall = printer_.timelockCalldata(timelock, escrow, data, printer_.resolveSalt(escrow, data));
        printer_.logTimelockCall(lastAcceptCall);
    }

    function _runTimelock() internal view returns (address timelock) {
        if (!broadcasting() && runInputsPinned) {
            if (pinnedRunTimelock == address(0)) revert("DeployEscrow: NEW_TIMELOCK unset");
            return pinnedRunTimelock;
        }
        timelock = readAddress("NEW_TIMELOCK", "DeployEscrow: NEW_TIMELOCK unset");
    }

    function _runDenylist() internal view returns (address denylist) {
        if (!broadcasting() && runInputsPinned) {
            if (pinnedRunDenylist == address(0)) revert("DeployEscrow: DENYLIST unset");
            return pinnedRunDenylist;
        }
        denylist = readAddress("DENYLIST", "DeployEscrow: DENYLIST unset");
    }

    function _runVault() internal view returns (address vault) {
        if (!broadcasting() && runInputsPinned) {
            if (pinnedRunVault == address(0)) revert("DeployEscrow: VAULT unset");
            return pinnedRunVault;
        }
        vault = readAddress("VAULT", "DeployEscrow: VAULT unset");
    }

    function _runPanel() internal view returns (address panel) {
        if (!broadcasting() && runInputsPinned) {
            if (pinnedRunPanel == address(0)) revert("DeployEscrow: DISPUTE_PANEL unset");
            return pinnedRunPanel;
        }
        panel = readAddress("DISPUTE_PANEL", "DeployEscrow: DISPUTE_PANEL unset");
    }

    function _printer() internal returns (OpsTimelockCall printer_) {
        if (address(printer) == address(0)) printer = new OpsTimelockCall();
        printer_ = printer;
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

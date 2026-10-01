// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

interface ISafe {
    function getThreshold() external view returns (uint256);
}

/// @notice Move ownership off `CORE_TIMELOCK` `0x10CC…78D9` onto a deployed `TimelockController`.
/// @dev `CORE_TIMELOCK` is an EOA with EIP-7702 delegation, not a timelock. Step `transfer` is the
///      only broadcast, and only Spencer runs it (`--account` / `--sender` that EOA, `vm.startBroadcast()`
///      with no key). This script never reads `PRIVATE_KEY`.
///      Ownable2Step `acceptOwnership` is not broadcast. `accept` prints `scheduleBatch` / `executeBatch`
///      calldata for the existing Safe. After `getMinDelay`, anyone executes when the executor is open.
///      Contracts with immediate `setOwner` (no `pendingOwner`) move in step `transfer`. That handoff has
///      no delay. The log says so.
///      A contract whose `governance()` is `CORE_TIMELOCK` is skipped unless `MIGRATE_ESCROWS=1`.
///      Moving that owner bricks `createEscrow` and the dependency setters, because `governance` is immutable.
///      Steps `transfer` and `accept` both call `requireValidTimelock` before any handoff.
///      Chain ids 8453 and 1 revert unless `ALLOW_MAINNET=1`. Mainnet is not in scope.
///      Agents do not pass `--broadcast`. This script does not create a Safe.
contract MigrateOwnershipToTimelock is Script {
    address public constant CORE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant BASE_MAINNET_CHAIN_ID = 8453;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;

    address public constant SIMULATE_SENDER = 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001;
    address public constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev Set by tests so parallel `forge test` runs do not share `MIGRATE_ESCROWS`. Operators use the env var.
    bool public forceEscrowMigration;

    /// @dev Stable salt so a resumed print of the same remaining set matches the scheduled operation.
    bytes32 public constant ACCEPT_SALT = keccak256("CORE_TIMELOCK_MIGRATION_ACCEPT_V1");
    bytes32 public constant PREDECESSOR = bytes32(0);

    uint256 internal constant BOOK_SLOTS = 14;

    struct TransferResult {
        uint256 immediate;
        uint256 twoStepQueued;
        uint256 pendingThenQueued;
        uint256 skipped;
    }

    function broadcasting() public view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    function allowMainnet() public view returns (bool allowed) {
        try vm.envUint("ALLOW_MAINNET") returns (uint256 flag) {
            allowed = flag == 1;
        } catch {
            allowed = false;
        }
    }

    function requireAllowedChain() public view {
        if (block.chainid == BASE_MAINNET_CHAIN_ID || block.chainid == ETH_MAINNET_CHAIN_ID) {
            if (!allowMainnet()) revert("MigrateOwnership: mainnet refused; set ALLOW_MAINNET=1");
            console.log("WARNING: mainnet is not in scope");
        }
    }

    /// @notice Step `transfer` broadcast must be the `CORE_TIMELOCK` keystore, not the default sender.
    function requireBroadcastSender(
        address sender
    ) public pure {
        if (sender == FOUNDRY_DEFAULT_SENDER || sender == SIMULATE_SENDER) {
            revert("MigrateOwnership: pass --account and --sender");
        }
        if (sender != CORE_TIMELOCK) revert("MigrateOwnership: sender must be CORE_TIMELOCK");
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

    /// @notice Escrow rows are included only when `MIGRATE_ESCROWS=1`, or when a test called `optInEscrows`.
    function migrateEscrows() public view returns (bool enabled) {
        if (forceEscrowMigration) return true;
        try vm.envUint("MIGRATE_ESCROWS") returns (uint256 flag) {
            enabled = flag == 1;
        } catch {
            enabled = false;
        }
    }

    /// @notice Opt the in-memory script instance into escrow migration. Broadcast still requires `MIGRATE_ESCROWS=1`.
    function optInEscrows() external {
        if (broadcasting()) revert("MigrateOwnership: set MIGRATE_ESCROWS=1");
        forceEscrowMigration = true;
    }

    /// @notice Reject a controller that is not the Safe's self-administered timelock, before any ownership call.
    /// @dev `SAFE_ADDRESS` must be the proposer and `getThreshold()` must be at least 2. `DEFAULT_ADMIN_ROLE` must sit
    ///      on the timelock only. `CORE_TIMELOCK` must not hold proposer, executor, canceller, or admin.
    ///      `getMinDelay()` must be non-zero. The address must have code.
    function requireValidTimelock(
        address newTimelock
    ) public view {
        if (newTimelock.code.length == 0) revert("MigrateOwnership: NEW_TIMELOCK has no code");
        address safe = readAddress("SAFE_ADDRESS", "MigrateOwnership: SAFE_ADDRESS unset");
        if (ISafe(safe).getThreshold() < 2) revert("MigrateOwnership: SAFE threshold is below 2");
        TimelockController tl = TimelockController(payable(newTimelock));
        if (!tl.hasRole(tl.PROPOSER_ROLE(), safe)) revert("MigrateOwnership: SAFE missing PROPOSER_ROLE");
        if (!tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), newTimelock)) {
            revert("MigrateOwnership: timelock is not self-administered");
        }
        if (tl.hasRole(tl.PROPOSER_ROLE(), CORE_TIMELOCK)) {
            revert("MigrateOwnership: CORE_TIMELOCK holds PROPOSER_ROLE");
        }
        if (tl.hasRole(tl.EXECUTOR_ROLE(), CORE_TIMELOCK)) {
            revert("MigrateOwnership: CORE_TIMELOCK holds EXECUTOR_ROLE");
        }
        if (tl.hasRole(tl.CANCELLER_ROLE(), CORE_TIMELOCK)) {
            revert("MigrateOwnership: CORE_TIMELOCK holds CANCELLER_ROLE");
        }
        if (tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), CORE_TIMELOCK)) {
            revert("MigrateOwnership: CORE_TIMELOCK holds DEFAULT_ADMIN_ROLE");
        }
        if (tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), msg.sender)) {
            revert("MigrateOwnership: msg.sender holds DEFAULT_ADMIN_ROLE");
        }
        if (tl.getMinDelay() == 0) revert("MigrateOwnership: minDelay is zero");
    }

    function bookEntries() public view returns (string[] memory names, address[] memory targets) {
        string memory json = vm.readFile("deployments/base-sepolia.json");
        names = new string[](BOOK_SLOTS);
        targets = new address[](BOOK_SLOTS);
        for (uint256 i = 0; i < BOOK_SLOTS; i++) {
            names[i] = _slotName(i);
            targets[i] = _readAddr(json, _slotPath(i));
        }
    }

    /// @notice `owner()` plus `pendingOwner()` when the call succeeds (Ownable2Step). A reverting `pendingOwner` is
    /// immediate `setOwner`.
    function inspect(
        address target
    ) public view returns (bool hasOwner, address owner, bool twoStep, address pending) {
        if (target == address(0) || target.code.length == 0) return (false, address(0), false, address(0));
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length < 32) return (false, address(0), false, address(0));
        owner = abi.decode(data, (address));
        hasOwner = true;
        (bool okPending, bytes memory pendingData) = target.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (okPending && pendingData.length >= 32) {
            twoStep = true;
            pending = abi.decode(pendingData, (address));
        }
    }

    /// @notice Immutable `governance()` when the contract has that getter. Zero when it does not.
    function governanceOf(
        address target
    ) public view returns (address governance) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature("governance()"));
        if (ok && data.length >= 32) governance = abi.decode(data, (address));
    }

    /// @notice True when `isArbitrator(CORE_TIMELOCK)` returns true. False when the call is absent or false.
    function coreIsArbitrator(
        address target
    ) public view returns (bool seated) {
        (bool ok, bytes memory data) =
            target.staticcall(abi.encodeWithSignature("isArbitrator(address)", CORE_TIMELOCK));
        if (ok && data.length >= 32) seated = abi.decode(data, (bool));
    }

    /// @notice Resumable handoff. Skips contracts already on `newTimelock` and two-step rows already pending that
    /// address. When `CORE_TIMELOCK` is only `pendingOwner`, it accepts, then `transferOwnership` to the timelock.
    function transferAll(
        address[] memory targets,
        address newTimelock
    ) public returns (TransferResult memory result) {
        requireValidTimelock(newTimelock);
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            uint8 kind = _transferOne(targets[i], newTimelock);
            if (kind == 1) result.immediate += 1;
            else if (kind == 2) result.twoStepQueued += 1;
            else if (kind == 3) result.pendingThenQueued += 1;
            else result.skipped += 1;
        }
    }

    /// @notice Ownable2Step rows that still need `acceptOwnership` from `newTimelock`.
    function collectAccept(
        address[] memory targets,
        address newTimelock
    )
        public
        view
        returns (
            address[] memory batchTargets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        )
    {
        uint256 n = targets.length;
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            if (_needsAccept(targets[i], newTimelock)) count += 1;
        }
        batchTargets = new address[](count);
        values = new uint256[](count);
        payloads = new bytes[](count);
        bytes memory payload = abi.encodeWithSignature("acceptOwnership()");
        uint256 w;
        for (uint256 i = 0; i < n; i++) {
            if (!_needsAccept(targets[i], newTimelock)) continue;
            batchTargets[w] = targets[i];
            values[w] = 0;
            payloads[w] = payload;
            w += 1;
        }
        predecessor = PREDECESSOR;
        salt = ACCEPT_SALT;
    }

    /// @notice After the accept batch has executed, every in-scope row sits on `newTimelock` with `pendingOwner == 0`.
    /// @dev When `MIGRATE_ESCROWS` is unset, a row whose `governance()` is `CORE_TIMELOCK` may stay owned by that EOA.
    ///      When it is `1`, those rows must be on `newTimelock` with `pendingOwner == 0`.
    function postCheck(
        address[] memory targets,
        address newTimelock
    ) public view {
        bool includeEscrows = migrateEscrows();
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            bool escrowRow = _escrowHeldByCore(targets[i]);
            if (escrowRow && !includeEscrows) continue;
            (bool hasOwner, address owner, bool twoStep, address pending) = inspect(targets[i]);
            if (escrowRow) {
                if (!hasOwner || owner != newTimelock) revert("MigrateOwnership: escrow owner is not the timelock");
                if (!twoStep || pending != address(0)) revert("MigrateOwnership: pendingOwner not cleared");
                continue;
            }
            if (!hasOwner) continue;
            if (owner == CORE_TIMELOCK) revert("MigrateOwnership: CORE_TIMELOCK still owns");
            if (twoStep && pending == CORE_TIMELOCK) revert("MigrateOwnership: CORE_TIMELOCK is still pendingOwner");
            bool inScope = owner == newTimelock || pending == newTimelock;
            if (!inScope) continue;
            if (owner != newTimelock) revert("MigrateOwnership: owner is not the timelock");
            if (twoStep && pending != address(0)) revert("MigrateOwnership: pendingOwner not cleared");
        }
    }

    function run() external {
        requireAllowedChain();
        address newTimelock = readAddress("NEW_TIMELOCK", "MigrateOwnership: NEW_TIMELOCK unset");
        if (newTimelock.code.length == 0) revert("MigrateOwnership: NEW_TIMELOCK has no code");

        string memory step = vm.envOr("MIGRATION_STEP", string("transfer"));
        (string[] memory names, address[] memory targets) = bookEntries();
        _logBook(names, targets, newTimelock);

        if (_eq(step, "transfer")) {
            requireValidTimelock(newTimelock);
            bool send = broadcasting();
            if (send) {
                requireBroadcastSender(msg.sender);
                console.log("BROADCAST Spencer-only");
                vm.startBroadcast();
            } else {
                console.log("SIMULATE; no transaction will be sent");
            }
            transferAll(targets, newTimelock);
            if (send) vm.stopBroadcast();
            _printAccept(targets, newTimelock);
        } else if (_eq(step, "accept")) {
            requireValidTimelock(newTimelock);
            console.log("SIMULATE; no transaction will be sent");
            _printAccept(targets, newTimelock);
        } else if (_eq(step, "check")) {
            console.log("SIMULATE; no transaction will be sent");
            postCheck(targets, newTimelock);
            console.log("post-check ok");
        } else {
            revert("MigrateOwnership: MIGRATION_STEP must be transfer, accept, or check");
        }
    }

    function _transferOne(
        address target,
        address newTimelock
    ) internal returns (uint8 kind) {
        if (newTimelock == address(0)) revert("MigrateOwnership: NEW_TIMELOCK unset");
        if (_escrowHeldByCore(target) && !migrateEscrows()) {
            console.log("skip: immutable governance; migrating bricks createEscrow and the setters", target);
            return 0;
        }
        (bool hasOwner, address owner, bool twoStep, address pending) = inspect(target);
        if (!hasOwner) return 0;
        _logPrivileges(target);

        if (owner == newTimelock && (!twoStep || pending == address(0))) {
            console.log("skip already migrated", target);
            return 0;
        }
        if (twoStep && owner == CORE_TIMELOCK && pending == newTimelock) {
            console.log("skip transfer; accept still pending", target);
            return 0;
        }
        if (twoStep && pending == CORE_TIMELOCK && owner != CORE_TIMELOCK) {
            console.log("CORE_TIMELOCK is pendingOwner; accept then transferOwnership", target);
            _asCore();
            (bool accepted, bytes memory acceptRet) = target.call(abi.encodeWithSignature("acceptOwnership()"));
            if (!accepted) _bubble(acceptRet, "MigrateOwnership: acceptOwnership failed");
            _asCore();
            (bool queued, bytes memory queueRet) =
                target.call(abi.encodeWithSignature("transferOwnership(address)", newTimelock));
            if (!queued) _bubble(queueRet, "MigrateOwnership: transferOwnership failed");
            return 3;
        }
        if (owner != CORE_TIMELOCK) {
            console.log("skip owner is not CORE_TIMELOCK", target);
            return 0;
        }
        if (twoStep && pending != address(0)) revert("MigrateOwnership: unexpected pendingOwner");
        if (twoStep) {
            _asCore();
            (bool ok, bytes memory ret) =
                target.call(abi.encodeWithSignature("transferOwnership(address)", newTimelock));
            if (!ok) _bubble(ret, "MigrateOwnership: transferOwnership failed");
            console.log("transferOwnership; timelock must acceptOwnership", target);
            return 2;
        }
        console.log("WARNING: immediate setOwner; this handoff has no delay", target);
        _asCore();
        (bool setOk, bytes memory setRet) = target.call(abi.encodeWithSignature("setOwner(address)", newTimelock));
        if (!setOk) _bubble(setRet, "MigrateOwnership: setOwner failed");
        return 1;
    }

    function _needsAccept(
        address target,
        address newTimelock
    ) internal view returns (bool) {
        if (_escrowHeldByCore(target) && !migrateEscrows()) return false;
        (bool hasOwner,, bool twoStep, address pending) = inspect(target);
        // Only rows already pending the new controller. A batch built before `transferOwnership`
        // would revert inside `acceptOwnership`.
        return hasOwner && twoStep && pending == newTimelock;
    }

    /// @dev True when `target`'s `governance()` is `CORE_TIMELOCK`. Those rows are the live and retired escrows.
    function _escrowHeldByCore(
        address target
    ) internal view returns (bool) {
        return governanceOf(target) == CORE_TIMELOCK;
    }

    function _asCore() internal {
        if (!broadcasting()) vm.prank(CORE_TIMELOCK);
    }

    function _logPrivileges(
        address target
    ) internal view {
        address governance = governanceOf(target);
        if (governance == CORE_TIMELOCK) {
            console.log("UNMIGRATABLE immutable governance remains CORE_TIMELOCK", target);
            console.log("after owner moves, createEscrow and dependency setters revert until a new escrow is deployed");
        }
        if (coreIsArbitrator(target)) {
            console.log("CORE_TIMELOCK isArbitrator; seat is not cleared by this script", target);
        }
    }

    function _logBook(
        string[] memory names,
        address[] memory targets,
        address newTimelock
    ) internal view {
        console.log("chainid", block.chainid);
        console.log("NEW_TIMELOCK", newTimelock);
        console.log("CORE_TIMELOCK", CORE_TIMELOCK);
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            (bool hasOwner, address owner, bool twoStep, address pending) = inspect(targets[i]);
            console.log(names[i], targets[i]);
            if (!hasOwner) {
                console.log("  no owner() or no code");
                continue;
            }
            console.log("  owner", owner);
            if (twoStep) {
                console.log("  Ownable2Step pending", pending);
            } else {
                console.log("  immediate setOwner");
            }
            if (owner == CORE_TIMELOCK) console.log("  include: live owner is CORE_TIMELOCK");
            address governance = governanceOf(targets[i]);
            if (governance != address(0)) console.log("  governance", governance);
            if (governance == CORE_TIMELOCK && !migrateEscrows()) {
                console.log(
                    "  skip unless MIGRATE_ESCROWS=1: immutable governance; migrating bricks createEscrow and the setters"
                );
            }
        }
    }

    function _printAccept(
        address[] memory targets,
        address newTimelock
    ) internal view {
        (
            address[] memory batchTargets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        ) = collectAccept(targets, newTimelock);
        uint256 delay = TimelockController(payable(newTimelock)).getMinDelay();
        console.log("accept batch length", batchTargets.length);
        console.log("predecessor");
        console.logBytes32(predecessor);
        console.log("salt");
        console.logBytes32(salt);
        console.log("delay", delay);
        uint256 n = batchTargets.length;
        for (uint256 i = 0; i < n; i++) {
            console.log("target", batchTargets[i]);
            console.log("value", values[i]);
            console.log("payload");
            console.logBytes(payloads[i]);
        }
        if (n == 0) {
            console.log("no Ownable2Step accept batch");
            return;
        }
        bytes32 id = TimelockController(payable(newTimelock))
            .hashOperationBatch(batchTargets, values, payloads, predecessor, salt);
        console.log("operationId");
        console.logBytes32(id);
        console.log("scheduleBatch calldata");
        console.logBytes(
            abi.encodeWithSelector(
                TimelockController.scheduleBatch.selector, batchTargets, values, payloads, predecessor, salt, delay
            )
        );
        console.log("executeBatch calldata");
        console.logBytes(
            abi.encodeWithSelector(
                TimelockController.executeBatch.selector, batchTargets, values, payloads, predecessor, salt
            )
        );
        console.log("Safe proposes scheduleBatch. After the delay, executeBatch. This step does not broadcast.");
    }

    function _readAddr(
        string memory json,
        string memory key
    ) internal view returns (address a) {
        try vm.parseJsonAddress(json, key) returns (address parsed) {
            a = parsed;
        } catch {
            a = address(0);
        }
    }

    function _bubble(
        bytes memory ret,
        string memory fallbackErr
    ) internal pure {
        if (ret.length == 0) revert(fallbackErr);
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }

    function _eq(
        string memory a,
        string memory b
    ) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _slotName(
        uint256 i
    ) internal pure returns (string memory) {
        if (i == 0) return "Denylist";
        if (i == 1) return "Vault";
        if (i == 2) return "Liability";
        if (i == 3) return "InsuranceFund";
        if (i == 4) return "DisputePanel";
        if (i == 5) return "BotAttestationEscrow";
        if (i == 6) return "BVT";
        if (i == 7) return "BVTStaking";
        if (i == 8) return "BVTFeeRouter";
        if (i == 9) return "BVTTimelock";
        if (i == 10) return "BVTGovernor";
        if (i == 11) return "superseded.Denylist";
        if (i == 12) return "superseded.Vault";
        return "retired.BotAttestationEscrow";
    }

    function _slotPath(
        uint256 i
    ) internal pure returns (string memory) {
        if (i == 0) return ".Denylist.address";
        if (i == 1) return ".Vault.address";
        if (i == 2) return ".Liability.address";
        if (i == 3) return ".InsuranceFund.address";
        if (i == 4) return ".DisputePanel.address";
        if (i == 5) return ".BotAttestationEscrow.address";
        if (i == 6) return ".BVT.address";
        if (i == 7) return ".BVTStaking.address";
        if (i == 8) return ".BVTFeeRouter.address";
        if (i == 9) return ".BVTTimelock.address";
        if (i == 10) return ".BVTGovernor.address";
        if (i == 11) return ".superseded.Denylist.address";
        if (i == 12) return ".superseded.Vault.address";
        return ".retired.BotAttestationEscrow.address";
    }
}

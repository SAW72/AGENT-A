// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";

interface IOwner {
    function owner() external view returns (address);
}

/// @notice Chain, address, and owner guards for the live Base Sepolia Denylist and Vault.
/// @dev Does not deploy those contracts. Canonical addresses are
///      `deployments/base-sepolia.json`. `NEW_TIMELOCK` is required and has no default.
///      While `owner()` is still `LIVE_TIMELOCK` (the pre-migration CORE EOA), the
///      legacy path impersonates that EOA and sends nothing on a dry run.
///      `--broadcast` on that path is Spencer-only. Once `owner()` is `NEW_TIMELOCK`,
///      owner calls are not sent: the script prints Safe-ready `schedule` / `execute`
///      calldata. Any other owner reverts. Agents must not pass `--broadcast`.
///      Chain ids 84532 and 31337 proceed. Mainnet (chainid 1) always reverts.
abstract contract OpsLive is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ANVIL_CHAIN_ID = 31337;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;
    uint256 public constant ALLOWED_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

    address public constant LIVE_DENYLIST = 0xeE76876bECcFc1B58fC06fF4E654a517d784B224;
    address public constant LIVE_VAULT = 0x1463D664fA467FBCDA4B05443434494f05e565bc;
    /// @dev Pre-migration owner. The CORE EOA, not the TimelockController.
    address public constant LIVE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;

    bytes32 public constant SALT_TAG = keccak256("OPS_OWNER_CALL_V1");

    struct TimelockCall {
        address target;
        bytes data;
        uint256 value;
        bytes32 predecessor;
        bytes32 salt;
        uint256 delay;
        bytes scheduleCalldata;
        bytes executeCalldata;
        bytes32 operationId;
    }

    /// @dev Previous pair. Still on chain. These scripts refuse it.
    address public constant SUPERSEDED_DENYLIST = 0xF0f260967D377E07Bdd7840862508ddB23C012b8;
    address public constant SUPERSEDED_VAULT = 0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7;

    function requireAllowedChain() public view {
        if (block.chainid == ETH_MAINNET_CHAIN_ID) {
            revert("OpsLive: mainnet forbidden");
        }
        if (block.chainid != ALLOWED_CHAIN_ID && block.chainid != ANVIL_CHAIN_ID) {
            revert("OpsLive: Base Sepolia (84532) or Anvil (31337) only");
        }
    }

    function broadcasting() public view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
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

    function readBytes32(
        string memory key,
        string memory unsetErr
    ) public view returns (bytes32 v) {
        try vm.envBytes32(key) returns (bytes32 set) {
            v = set;
        } catch {
            revert(unsetErr);
        }
    }

    function readString(
        string memory key,
        string memory unsetErr
    ) public view returns (string memory v) {
        try vm.envString(key) returns (string memory set) {
            v = set;
        } catch {
            revert(unsetErr);
        }
        if (bytes(v).length == 0) revert(unsetErr);
    }

    function assertCanonicalDenylist(
        address denylist,
        address timelock
    ) public pure {
        if (denylist == SUPERSEDED_DENYLIST) revert("OpsLive: superseded Denylist");
        if (denylist != LIVE_DENYLIST) revert("OpsLive: DENYLIST is not the live Base Sepolia Denylist");
        if (timelock != LIVE_TIMELOCK) revert("OpsLive: CORE_TIMELOCK is not the live owner");
    }

    function assertCanonicalVault(
        address denylist,
        address vault,
        address timelock
    ) public pure {
        assertCanonicalDenylist(denylist, timelock);
        if (vault == SUPERSEDED_VAULT) revert("OpsLive: superseded Vault");
        if (vault != LIVE_VAULT) revert("OpsLive: VAULT is not the live Base Sepolia Vault");
    }

    /// @notice Load the live Denylist. `NEW_TIMELOCK` is required and is not defaulted to CORE.
    function loadDenylist() public view returns (Denylist denylist, address newTimelock) {
        address denylistAddr = readAddress("DENYLIST", "OpsLive: DENYLIST unset");
        newTimelock = readAddress("NEW_TIMELOCK", "OpsLive: NEW_TIMELOCK unset");
        if (denylistAddr == SUPERSEDED_DENYLIST) revert("OpsLive: superseded Denylist");
        if (denylistAddr != LIVE_DENYLIST) revert("OpsLive: DENYLIST is not the live Base Sepolia Denylist");
        denylist = Denylist(denylistAddr);
    }

    function assertDenylistOwner(
        address owner,
        address timelock
    ) public pure {
        if (owner != timelock) revert("OpsLive: Denylist.owner is not CORE_TIMELOCK");
    }

    /// @notice Load the live Vault. Reverts if it does not point at the live Denylist.
    function loadVault() public view returns (Vault vault, address newTimelock) {
        address denylistAddr = readAddress("DENYLIST", "OpsLive: DENYLIST unset");
        address vaultAddr = readAddress("VAULT", "OpsLive: VAULT unset");
        newTimelock = readAddress("NEW_TIMELOCK", "OpsLive: NEW_TIMELOCK unset");
        if (denylistAddr == SUPERSEDED_DENYLIST) revert("OpsLive: superseded Denylist");
        if (denylistAddr != LIVE_DENYLIST) revert("OpsLive: DENYLIST is not the live Base Sepolia Denylist");
        if (vaultAddr == SUPERSEDED_VAULT) revert("OpsLive: superseded Vault");
        if (vaultAddr != LIVE_VAULT) revert("OpsLive: VAULT is not the live Base Sepolia Vault");
        vault = Vault(vaultAddr);
        if (address(vault.denylist()) != denylistAddr) revert("OpsLive: Vault.denylist is not DENYLIST");
    }

    /// @notice Calldata mode when `owner` is `newTimelock`. Legacy only while `owner` is the pre-migration CORE EOA.
    function timelockMode(
        address owner,
        address newTimelock
    ) public pure returns (bool calldataMode) {
        if (newTimelock == address(0)) revert("OpsLive: NEW_TIMELOCK unset");
        if (owner == newTimelock) return true;
        if (owner == LIVE_TIMELOCK) return false;
        revert("OpsLive: owner is neither NEW_TIMELOCK nor pre-migration CORE");
    }

    /// @notice `TIMELOCK_SALT` when set. Otherwise `keccak256(tag, target, data)`.
    function resolveSalt(
        address target,
        bytes memory data
    ) public view returns (bytes32 salt) {
        try vm.envBytes32("TIMELOCK_SALT") returns (bytes32 set) {
            return set;
        } catch { }
        return keccak256(abi.encode(SALT_TAG, target, data));
    }

    /// @notice Safe-ready `schedule` / `execute` for one owner call. Delay is `getMinDelay()`. Value and predecessor are 0.
    function timelockCalldata(
        address timelock,
        address target,
        bytes memory data,
        bytes32 salt
    ) public view returns (TimelockCall memory call) {
        if (timelock == address(0)) revert("OpsLive: NEW_TIMELOCK unset");
        if (timelock.code.length == 0) revert("OpsLive: NEW_TIMELOCK has no code");
        uint256 delay;
        try TimelockController(payable(timelock)).getMinDelay() returns (uint256 got) {
            delay = got;
        } catch {
            revert("OpsLive: NEW_TIMELOCK getMinDelay failed");
        }
        bytes32 predecessor = bytes32(0);
        call.target = target;
        call.data = data;
        call.value = 0;
        call.predecessor = predecessor;
        call.salt = salt;
        call.delay = delay;
        call.scheduleCalldata = abi.encodeWithSelector(
            TimelockController.schedule.selector, target, uint256(0), data, predecessor, salt, delay
        );
        call.executeCalldata =
            abi.encodeWithSelector(TimelockController.execute.selector, target, uint256(0), data, predecessor, salt);
        call.operationId = TimelockController(payable(timelock)).hashOperation(target, 0, data, predecessor, salt);
    }

    /// @dev Timelock owner: print calldata and do not send. Pre-migration CORE owner: send as that EOA.
    function performOwnerCall(
        address target,
        bytes memory data
    ) public returns (bool sent) {
        address newTimelock = readAddress("NEW_TIMELOCK", "OpsLive: NEW_TIMELOCK unset");
        address owner = IOwner(target).owner();
        if (timelockMode(owner, newTimelock)) {
            _logTimelockCall(timelockCalldata(newTimelock, target, data, resolveSalt(target, data)));
            return false;
        }
        console.log("pre-migration/legacy: owner is CORE_TIMELOCK");
        bool broadcast = asOwner(LIVE_TIMELOCK);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) _bubble(ret, "OpsLive: owner call failed");
        finishOwner(broadcast);
        return true;
    }

    function _logTimelockCall(
        TimelockCall memory call
    ) internal pure {
        console.log("TIMELOCK calldata mode; no transaction will be sent");
        console.log("target", call.target);
        console.log("inner calldata");
        console.logBytes(call.data);
        console.log("predecessor");
        console.logBytes32(call.predecessor);
        console.log("salt");
        console.logBytes32(call.salt);
        console.log("delay", call.delay);
        console.log("schedule calldata");
        console.logBytes(call.scheduleCalldata);
        console.log("execute calldata");
        console.logBytes(call.executeCalldata);
        console.log("operationId");
        console.logBytes32(call.operationId);
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

    function assertVaultWired(
        address owner,
        address vaultDenylist,
        address denylist,
        address timelock
    ) public pure {
        if (owner != timelock) revert("OpsLive: Vault.owner is not CORE_TIMELOCK");
        if (vaultDenylist != denylist) revert("OpsLive: Vault.denylist is not DENYLIST");
    }

    function parseBucket(
        string memory name
    ) public pure returns (Denylist.Bucket) {
        if (_eq(name, "Exact")) return Denylist.Bucket.Exact;
        if (_eq(name, "Signature")) return Denylist.Bucket.Signature;
        if (_eq(name, "Prompt")) return Denylist.Bucket.Prompt;
        revert("OpsLive: BUCKET must be Exact, Signature, or Prompt");
    }

    function parseTier(
        string memory name
    ) public pure returns (Vault.Tier) {
        if (_eq(name, "None")) return Vault.Tier.None;
        if (_eq(name, "Chat")) return Vault.Tier.Chat;
        if (_eq(name, "DataTools")) return Vault.Tier.DataTools;
        if (_eq(name, "Financial")) return Vault.Tier.Financial;
        if (_eq(name, "Critical")) return Vault.Tier.Critical;
        revert("OpsLive: TIER must be None, Chat, DataTools, Financial, or Critical");
    }

    /// @dev Dry-run: `prank` the owner for the next external call. No key, no send.
    ///      Broadcast / resume: `PRIVATE_KEY` must be that owner, then `startBroadcast`.
    function asOwner(
        address owner
    ) internal returns (bool send) {
        if (owner == address(0)) revert("OpsLive: owner unset");
        send = broadcasting();
        if (send) {
            console.log("BROADCAST Spencer-only");
            uint256 key = vm.envUint("PRIVATE_KEY");
            address sender = vm.addr(key);
            if (sender != owner) revert("OpsLive: PRIVATE_KEY is not the live owner; Spencer only");
            vm.startBroadcast(key);
        } else {
            console.log("SIMULATE; no transaction will be sent");
            vm.prank(owner);
        }
    }

    function finishOwner(
        bool send
    ) internal {
        if (send) vm.stopBroadcast();
    }

    function _eq(
        string memory a,
        string memory b
    ) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}

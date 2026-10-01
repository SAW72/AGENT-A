// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";

/// @notice Chain, address, and owner guards for the live Base Sepolia Denylist and Vault.
/// @dev Does not deploy those contracts. Canonical addresses are
///      `deployments/base-sepolia.json`. Dry-run impersonates the live owner and
///      sends nothing. `--broadcast` is Spencer-only: `PRIVATE_KEY` must be that owner.
///      Agents must not pass `--broadcast`. Mainnet (chainid 1) always reverts.
abstract contract OpsLive is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;
    uint256 public constant ALLOWED_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

    address public constant LIVE_DENYLIST = 0xeE76876bECcFc1B58fC06fF4E654a517d784B224;
    address public constant LIVE_VAULT = 0x1463D664fA467FBCDA4B05443434494f05e565bc;
    address public constant LIVE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;

    /// @dev Previous pair. Still on chain. These scripts refuse it.
    address public constant SUPERSEDED_DENYLIST = 0xF0f260967D377E07Bdd7840862508ddB23C012b8;
    address public constant SUPERSEDED_VAULT = 0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7;

    function requireAllowedChain() public view {
        if (block.chainid == ETH_MAINNET_CHAIN_ID) {
            revert("OpsLive: mainnet forbidden");
        }
        if (block.chainid != ALLOWED_CHAIN_ID) {
            revert("OpsLive: Base Sepolia (84532) only");
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

    /// @notice Load the live Denylist after the env addresses match the book and `owner()` matches.
    function loadDenylist() public view returns (Denylist denylist, address timelock) {
        address denylistAddr = readAddress("DENYLIST", "OpsLive: DENYLIST unset");
        timelock = readAddress("CORE_TIMELOCK", "OpsLive: CORE_TIMELOCK unset");
        assertCanonicalDenylist(denylistAddr, timelock);
        denylist = Denylist(denylistAddr);
        assertDenylistOwner(denylist.owner(), timelock);
    }

    function assertDenylistOwner(
        address owner,
        address timelock
    ) public pure {
        if (owner != timelock) revert("OpsLive: Denylist.owner is not CORE_TIMELOCK");
    }

    /// @notice Load the live Vault. Reverts if it does not point at the live Denylist.
    function loadVault() public view returns (Vault vault, address timelock) {
        address denylistAddr = readAddress("DENYLIST", "OpsLive: DENYLIST unset");
        address vaultAddr = readAddress("VAULT", "OpsLive: VAULT unset");
        timelock = readAddress("CORE_TIMELOCK", "OpsLive: CORE_TIMELOCK unset");
        assertCanonicalVault(denylistAddr, vaultAddr, timelock);
        vault = Vault(vaultAddr);
        assertVaultWired(vault.owner(), address(vault.denylist()), denylistAddr, timelock);
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

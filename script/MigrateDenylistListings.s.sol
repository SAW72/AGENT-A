// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { Denylist } from "../contracts/Denylist.sol";

/// @notice Read path shared by the pre-PR #10 bool mappings and the tip `active` getters.
/// @dev Selectors match `denylistedHashes` / `denylistedSignatures` / `denylistedPrompts`.
///      On tip bytecode those getters return `listing(bucket, id).active`.
interface ILegacyDenylistView {
    function denylistedHashes(
        bytes32 id
    ) external view returns (bool);

    function denylistedSignatures(
        bytes32 id
    ) external view returns (bool);

    function denylistedPrompts(
        bytes32 id
    ) external view returns (bool);
}

/// @notice Replay currently-active denylist ids onto a new tip Denylist.
/// Ids come from `MIGRATION_FILE` (JSON). This script does not scrape logs and does not
/// invent ids. Each id must already be active on `OLD_DENYLIST` (view only).
/// Adds run only after `NEW_DENYLIST.owner()` is `CORE_TIMELOCK` and `pendingOwner` is zero.
/// The live pre-PR #10 Denylist is refused as `NEW_DENYLIST`. It is never a call target.
/// State-changing calls are `addExact` / `addSignature` / `addPrompt` on the new contract.
/// When the signer is not `CORE_TIMELOCK`, `run` logs the plan and broadcasts nothing.
/// Chainid guard: Base Sepolia (84532) only. Mainnet is always refused.
/// Agents do not --broadcast. Spencer runs any broadcast locally, or schedules the
/// same adds through the timelock. See script/DEPLOY_DENYLIST.md.
contract MigrateDenylistListings is Script {
    using stdJson for string;

    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ETH_SEPOLIA_CHAIN_ID = 11155111;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;
    uint256 public constant ALLOWED_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

    /// @dev Refusal guard only. Never a call target. Reads of the previous deployment
    ///      use `OLD_DENYLIST` from the environment and stay view calls before broadcast.
    address public constant LIVE_PRE_PR10_DENYLIST = 0xF0f260967D377E07Bdd7840862508ddB23C012b8;

    struct Migration {
        bytes32[] exact;
        bytes32[] signature;
        bytes32[] prompt;
    }

    function requireAllowedChain() public view {
        if (block.chainid == ETH_MAINNET_CHAIN_ID) {
            revert("MigrateDenylist: mainnet forbidden");
        }
        if (block.chainid != ALLOWED_CHAIN_ID) {
            revert("MigrateDenylist: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)");
        }
    }

    /// @notice Owner handoff must already be finished. Does not call `OLD_DENYLIST`.
    function preflight(
        address newDenylist,
        address oldDenylist,
        address timelock
    ) public view {
        if (timelock == address(0)) revert("MigrateDenylist: CORE_TIMELOCK unset");
        if (newDenylist == address(0)) revert("MigrateDenylist: NEW_DENYLIST unset");
        if (oldDenylist == address(0)) revert("MigrateDenylist: OLD_DENYLIST unset");
        if (newDenylist == oldDenylist) revert("MigrateDenylist: old and new must differ");
        if (newDenylist == LIVE_PRE_PR10_DENYLIST) revert("MigrateDenylist: refusing live pre-PR10 Denylist");
        if (newDenylist.code.length == 0) revert("MigrateDenylist: NEW_DENYLIST has no code");
        if (oldDenylist.code.length == 0) revert("MigrateDenylist: OLD_DENYLIST has no code");
        _requireTip(newDenylist);

        Denylist denylist = Denylist(newDenylist);
        if (denylist.owner() != timelock) {
            revert("MigrateDenylist: owner is not CORE_TIMELOCK; acceptOwnership first");
        }
        if (denylist.pendingOwner() != address(0)) revert("MigrateDenylist: ownership transfer still pending");
    }

    /// @notice Load `{ "exact": [], "signature": [], "prompt": [] }`. Values are 0x-prefixed bytes32.
    function loadMigration(
        string memory path
    ) public view returns (Migration memory listed) {
        string memory json = vm.readFile(path);
        listed.exact = json.readBytes32Array(".exact");
        listed.signature = json.readBytes32Array(".signature");
        listed.prompt = json.readBytes32Array(".prompt");
    }

    /// @notice Ids to add. Reverts if an id is zero, duplicated in its bucket, or inactive on old.
    /// Already-active ids on the new contract are omitted so a rerun is safe.
    function plan(
        address newDenylist,
        address oldDenylist,
        address timelock,
        Migration memory listed
    ) public view returns (Migration memory pending) {
        preflight(newDenylist, oldDenylist, timelock);
        Denylist denylist = Denylist(newDenylist);
        pending.exact = _pending(denylist, oldDenylist, listed.exact, Denylist.Bucket.Exact);
        pending.signature = _pending(denylist, oldDenylist, listed.signature, Denylist.Bucket.Signature);
        pending.prompt = _pending(denylist, oldDenylist, listed.prompt, Denylist.Bucket.Prompt);
    }

    /// @notice `addExact` / `addSignature` / `addPrompt` only. Does not call `OLD_DENYLIST`.
    /// Refuses the live pre-PR #10 address. Under `forge script` broadcast, those adds are
    /// sent by the signer (`CORE_TIMELOCK`). A direct call sends them as this contract.
    function applyPending(
        Denylist denylist,
        Migration memory pending
    ) public {
        if (address(denylist) == address(0)) revert("MigrateDenylist: NEW_DENYLIST unset");
        if (address(denylist) == LIVE_PRE_PR10_DENYLIST) revert("MigrateDenylist: refusing live pre-PR10 Denylist");
        _addAll(denylist, pending.exact, Denylist.Bucket.Exact);
        _addAll(denylist, pending.signature, Denylist.Bucket.Signature);
        _addAll(denylist, pending.prompt, Denylist.Bucket.Prompt);
    }

    function run() external {
        requireAllowedChain();

        uint256 signerKey = vm.envUint("PRIVATE_KEY");
        address signer = vm.addr(signerKey);
        address timelock = vm.envAddress("CORE_TIMELOCK");
        address newDenylist = vm.envAddress("NEW_DENYLIST");
        address oldDenylist = vm.envAddress("OLD_DENYLIST");
        string memory path = vm.envString("MIGRATION_FILE");

        Migration memory pending = plan(newDenylist, oldDenylist, timelock, loadMigration(path));
        uint256 count = pending.exact.length + pending.signature.length + pending.prompt.length;

        console.log("chainid", block.chainid);
        console.log("NEW_DENYLIST", newDenylist);
        console.log("OLD_DENYLIST", oldDenylist);
        console.log("CORE_TIMELOCK", timelock);
        console.log("pending exact", pending.exact.length);
        console.log("pending signature", pending.signature.length);
        console.log("pending prompt", pending.prompt.length);
        _logIds("addExact", pending.exact);
        _logIds("addSignature", pending.signature);
        _logIds("addPrompt", pending.prompt);

        if (count == 0) {
            console.log("Nothing to add. No transactions.");
            return;
        }
        if (signer != timelock) {
            console.log("Signer is not CORE_TIMELOCK. Not broadcasting.");
            console.log("Schedule the logged adds from CORE_TIMELOCK. See script/DEPLOY_DENYLIST.md.");
            return;
        }

        vm.startBroadcast(signerKey);
        applyPending(Denylist(newDenylist), pending);
        vm.stopBroadcast();

        console.log("Migration adds submitted by CORE_TIMELOCK. Agents must not --broadcast.");
    }

    function _requireTip(
        address denylist
    ) internal view {
        (bool ok, bytes memory data) =
            denylist.staticcall(abi.encodeWithSelector(Denylist.listing.selector, Denylist.Bucket.Exact, bytes32(0)));
        // Listing is seven static words: bool, four uint64, two address.
        if (!ok || data.length != 224) revert("MigrateDenylist: NEW_DENYLIST is not tip Denylist");
    }

    function _pending(
        Denylist denylist,
        address oldDenylist,
        bytes32[] memory ids,
        Denylist.Bucket bucket
    ) internal view returns (bytes32[] memory out) {
        bytes32[] memory seen = new bytes32[](ids.length);
        bytes32[] memory buf = new bytes32[](ids.length);
        uint256 seenCount;
        uint256 write;
        for (uint256 i = 0; i < ids.length; i++) {
            bytes32 id = ids[i];
            if (id == bytes32(0)) revert("MigrateDenylist: zero id");
            for (uint256 j = 0; j < seenCount; j++) {
                if (seen[j] == id) revert("MigrateDenylist: duplicate id");
            }
            seen[seenCount++] = id;
            if (!_legacyActive(oldDenylist, bucket, id)) revert("MigrateDenylist: id not active on old denylist");
            if (_tipActive(denylist, bucket, id)) continue;
            buf[write++] = id;
        }
        out = new bytes32[](write);
        for (uint256 i = 0; i < write; i++) {
            out[i] = buf[i];
        }
    }

    function _legacyActive(
        address oldDenylist,
        Denylist.Bucket bucket,
        bytes32 id
    ) internal view returns (bool) {
        ILegacyDenylistView legacy = ILegacyDenylistView(oldDenylist);
        if (bucket == Denylist.Bucket.Exact) return legacy.denylistedHashes(id);
        if (bucket == Denylist.Bucket.Signature) return legacy.denylistedSignatures(id);
        return legacy.denylistedPrompts(id);
    }

    function _tipActive(
        Denylist denylist,
        Denylist.Bucket bucket,
        bytes32 id
    ) internal view returns (bool) {
        if (bucket == Denylist.Bucket.Exact) return denylist.denylistedHashes(id);
        if (bucket == Denylist.Bucket.Signature) return denylist.denylistedSignatures(id);
        return denylist.denylistedPrompts(id);
    }

    function _addAll(
        Denylist denylist,
        bytes32[] memory ids,
        Denylist.Bucket bucket
    ) internal {
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == bytes32(0)) revert("MigrateDenylist: zero id");
            if (bucket == Denylist.Bucket.Exact) denylist.addExact(ids[i]);
            else if (bucket == Denylist.Bucket.Signature) denylist.addSignature(ids[i]);
            else denylist.addPrompt(ids[i]);
        }
    }

    function _logIds(
        string memory label,
        bytes32[] memory ids
    ) internal pure {
        for (uint256 i = 0; i < ids.length; i++) {
            console.log(label);
            console.logBytes32(ids[i]);
        }
    }
}

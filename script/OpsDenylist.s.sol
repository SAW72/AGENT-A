// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { console } from "forge-std/Script.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { OpsLive } from "./OpsLive.sol";

abstract contract OpsDenylistLog is OpsLive {
    function _logDenylist(
        string memory op,
        Denylist denylist,
        address timelock,
        bytes32 id,
        Denylist.Bucket bucket
    ) internal view {
        console.log("op", op);
        console.log("chainid", block.chainid);
        console.log("Denylist", address(denylist));
        console.log("CORE_TIMELOCK", timelock);
        console.log("bucket", uint256(bucket));
        console.logBytes32(id);
    }

    function _logRow(
        Denylist denylist,
        bytes32 id,
        Denylist.Bucket bucket
    ) internal view {
        Denylist.Listing memory row = denylist.listing(uint8(bucket), id);
        console.log("active", row.active);
        console.log("everListed", denylist.everListed(uint8(bucket), id));
        console.log("timesListed", uint256(row.timesListed));
    }
}

/// @notice `Denylist.addExact` on the live Base Sepolia denylist.
/// @dev Simulate: `forge script script/OpsDenylist.s.sol:OpsDenylistAddExact --rpc-url $BASE_SEPOLIA_RPC_URL`
///      Agents must not pass `--broadcast`. See script/OPS_LIVE_DENYLIST_VAULT.md.
contract OpsDenylistAddExact is OpsDenylistLog {
    function run() external {
        requireAllowedChain();
        (Denylist denylist, address timelock) = loadDenylist();
        bytes32 id = readBytes32("LISTING_ID", "OpsLive: LISTING_ID unset");
        _logDenylist("addExact", denylist, timelock, id, Denylist.Bucket.Exact);
        bool send = asOwner(timelock);
        denylist.addExact(id);
        finishOwner(send);
        _logRow(denylist, id, Denylist.Bucket.Exact);
    }
}

/// @notice `Denylist.addSignature` on the live Base Sepolia denylist.
contract OpsDenylistAddSignature is OpsDenylistLog {
    function run() external {
        requireAllowedChain();
        (Denylist denylist, address timelock) = loadDenylist();
        bytes32 id = readBytes32("LISTING_ID", "OpsLive: LISTING_ID unset");
        _logDenylist("addSignature", denylist, timelock, id, Denylist.Bucket.Signature);
        bool send = asOwner(timelock);
        denylist.addSignature(id);
        finishOwner(send);
        _logRow(denylist, id, Denylist.Bucket.Signature);
    }
}

/// @notice `Denylist.addPrompt` on the live Base Sepolia denylist.
/// @dev The resulting `check` level is `PromptBlock`, a hard block.
contract OpsDenylistAddPrompt is OpsDenylistLog {
    function run() external {
        requireAllowedChain();
        (Denylist denylist, address timelock) = loadDenylist();
        bytes32 id = readBytes32("LISTING_ID", "OpsLive: LISTING_ID unset");
        _logDenylist("addPrompt", denylist, timelock, id, Denylist.Bucket.Prompt);
        bool send = asOwner(timelock);
        denylist.addPrompt(id);
        finishOwner(send);
        _logRow(denylist, id, Denylist.Bucket.Prompt);
    }
}

/// @notice `Denylist.remove(id, bucket)` on the live Base Sepolia denylist.
/// @dev Clears `active` only. `timesListed` and `everListed` stay.
///      Env `BUCKET` is `Exact`, `Signature`, or `Prompt`.
contract OpsDenylistRemove is OpsDenylistLog {
    function run() external {
        requireAllowedChain();
        (Denylist denylist, address timelock) = loadDenylist();
        bytes32 id = readBytes32("LISTING_ID", "OpsLive: LISTING_ID unset");
        Denylist.Bucket bucket = parseBucket(readString("BUCKET", "OpsLive: BUCKET unset"));
        _logDenylist("remove", denylist, timelock, id, bucket);
        bool send = asOwner(timelock);
        denylist.remove(id, uint8(bucket));
        finishOwner(send);
        _logRow(denylist, id, bucket);
    }
}

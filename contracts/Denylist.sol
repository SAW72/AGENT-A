// SPDX-License-Identifier: MIT
// Denylist — active fingerprint blocks with a permanent listing history.
// Unaudited. Production-bound Base Sepolia code, not an illustration.
// The live deployment (deployments/base-sepolia.json) is owned by CORE_TIMELOCK.
// This file does not redeploy or upgrade that address.

pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Read path used by Vault registration and escrow verification.
/// @dev `MatchLevel` ordinals are ABI. Do not reorder:
///      `None = 0`, `PromptBlock = 1`, `SignatureBlock = 2`, `ExactBlock = 3`.
///      `PromptBlock` is the old `PromptReview` slot. Every non-`None` level is a hard block.
interface IDenylist {
    enum MatchLevel {
        None,
        PromptBlock,
        SignatureBlock,
        ExactBlock
    }

    function check(
        bytes32 weightHash,
        bytes32 behaviorSig,
        bytes32 promptHash
    ) external view returns (MatchLevel);
}

/// @title Denylist
/// @notice Owner-gated fingerprint denylist. Active membership can be cleared; the fact of a listing cannot.
/// @dev Unaudited production-bound testnet code. Live owner is CORE_TIMELOCK via Ownable2Step.
///      History model: one `Listing` per `(bucket, id)`. `active` is current membership.
///      `timesListed` increments on every successful add and never decreases, so `everListed`
///      stays true after `remove`. `Listed` / `Unlisted` are the append-only sequence
///      (actor = `msg.sender`, time = `block.timestamp`, id, bucket, listing count).
contract Denylist is Ownable2Step {
    /// @dev Same ordinals as `IDenylist.MatchLevel`. Do not reorder.
    enum MatchLevel {
        None,
        PromptBlock,
        SignatureBlock,
        ExactBlock
    }

    enum Bucket {
        Exact,
        Signature,
        Prompt
    }

    /// @notice Permanent record for one id in one bucket. `active` may clear; the rest may not.
    struct Listing {
        bool active;
        uint64 timesListed;
        uint64 firstListedAt;
        uint64 lastListedAt;
        uint64 lastUnlistedAt;
        address lastListedBy;
        address lastUnlistedBy;
    }

    mapping(bytes32 => Listing) private _exact;
    mapping(bytes32 => Listing) private _signature;
    mapping(bytes32 => Listing) private _prompt;

    /// @notice An id was activated. `timesListed` includes this add.
    event Listed(
        bytes32 indexed id, Bucket indexed bucket, address indexed actor, uint256 timestamp, uint64 timesListed
    );

    /// @notice An id was deactivated. `timesListed` is unchanged by the removal.
    event Unlisted(
        bytes32 indexed id, Bucket indexed bucket, address indexed actor, uint256 timestamp, uint64 timesListed
    );

    error ZeroId();
    error AlreadyListed(Bucket bucket, bytes32 id);
    error NotListed(Bucket bucket, bytes32 id);
    /// @notice `bucket` is not Exact (0), Signature (1), or Prompt (2).
    error InvalidBucket(uint8 bucket);

    constructor() Ownable(msg.sender) { }

    /// @notice Activate an exact weight hash. Reverts if that hash is already active.
    function addExact(
        bytes32 weightHash
    ) external onlyOwner {
        _list(weightHash, Bucket.Exact);
    }

    /// @notice Activate a behavioral signature. Reverts if that signature is already active.
    function addSignature(
        bytes32 behaviorSig
    ) external onlyOwner {
        _list(behaviorSig, Bucket.Signature);
    }

    /// @notice Activate a prompt hash. Reverts if that hash is already active.
    /// @dev The resulting `check` level is `PromptBlock`, a hard block. Same gate as exact and signature.
    function addPrompt(
        bytes32 promptHash
    ) external onlyOwner {
        _list(promptHash, Bucket.Prompt);
    }

    /// @notice Clear the active listing for `id` in `bucket`.
    /// @dev Owner-gated. Does not delete history: `timesListed`, `firstListedAt`, and `everListed` remain.
    ///      Re-adding the same id increments `timesListed` and emits `Listed` again.
    ///      `bytes32(0)` is not a valid id. A bucket must be named because one id can exist in more than one.
    ///      `bucket` is `Bucket` as `uint8`: Exact = 0, Signature = 1, Prompt = 2.
    ///      Any other value reverts `InvalidBucket` and does not read or write a row.
    function remove(
        bytes32 id,
        uint8 bucket
    ) external onlyOwner {
        _unlist(id, _asBucket(bucket));
    }

    /// @notice Strongest active match. `None` is the only level a gate may treat as clean.
    /// @dev View on purpose. Vault and escrow call `check` from their own transactions, including
    ///      via static execution. A `Checked` event cannot be emitted here, and a second
    ///      state-changing checker would be another source of truth. The audit trail is
    ///      `Listed` / `Unlisted`, not reads.
    ///      Priority: ExactBlock, then SignatureBlock, then PromptBlock, then None.
    function check(
        bytes32 weightHash,
        bytes32 behaviorSig,
        bytes32 promptHash
    ) external view returns (MatchLevel) {
        if (_exact[weightHash].active) return MatchLevel.ExactBlock;
        if (_signature[behaviorSig].active) return MatchLevel.SignatureBlock;
        if (_prompt[promptHash].active) return MatchLevel.PromptBlock;
        return MatchLevel.None;
    }

    /// @notice Current exact-hash membership. False after `remove`, including if the id was listed before.
    function denylistedHashes(
        bytes32 weightHash
    ) external view returns (bool) {
        return _exact[weightHash].active;
    }

    /// @notice Current signature membership.
    function denylistedSignatures(
        bytes32 behaviorSig
    ) external view returns (bool) {
        return _signature[behaviorSig].active;
    }

    /// @notice Current prompt-hash membership.
    function denylistedPrompts(
        bytes32 promptHash
    ) external view returns (bool) {
        return _prompt[promptHash].active;
    }

    /// @notice True once `id` has been listed in `bucket`, including after removal.
    /// @dev `bucket` is `Bucket` as `uint8`. Values other than Exact, Signature, or Prompt revert `InvalidBucket`.
    function everListed(
        uint8 bucket,
        bytes32 id
    ) external view returns (bool) {
        return _row(_asBucket(bucket), id).timesListed != 0;
    }

    /// @notice Full stored record. Survives `remove`.
    /// @dev `bucket` is `Bucket` as `uint8`. Values other than Exact, Signature, or Prompt revert `InvalidBucket`.
    function listing(
        uint8 bucket,
        bytes32 id
    ) external view returns (Listing memory) {
        return _row(_asBucket(bucket), id);
    }

    function _list(
        bytes32 id,
        Bucket bucket
    ) internal {
        if (id == bytes32(0)) revert ZeroId();
        Listing storage row = _row(bucket, id);
        if (row.active) revert AlreadyListed(bucket, id);

        row.active = true;
        uint64 nowTs = uint64(block.timestamp);
        if (row.timesListed == 0) row.firstListedAt = nowTs;
        row.timesListed += 1;
        row.lastListedAt = nowTs;
        row.lastListedBy = msg.sender;

        emit Listed(id, bucket, msg.sender, block.timestamp, row.timesListed);
    }

    function _unlist(
        bytes32 id,
        Bucket bucket
    ) internal {
        if (id == bytes32(0)) revert ZeroId();
        Listing storage row = _row(bucket, id);
        if (!row.active) revert NotListed(bucket, id);

        row.active = false;
        row.lastUnlistedAt = uint64(block.timestamp);
        row.lastUnlistedBy = msg.sender;

        emit Unlisted(id, bucket, msg.sender, block.timestamp, row.timesListed);
    }

    /// @dev Only Exact, Signature, and Prompt select a mapping. Anything else reverts.
    ///      It must not fall through to `_prompt`.
    function _asBucket(
        uint8 bucket
    ) internal pure returns (Bucket) {
        if (bucket == uint8(Bucket.Exact)) return Bucket.Exact;
        if (bucket == uint8(Bucket.Signature)) return Bucket.Signature;
        if (bucket == uint8(Bucket.Prompt)) return Bucket.Prompt;
        revert InvalidBucket(bucket);
    }

    /// @dev Exhaustive on the three valid buckets. The else is not a Prompt alias.
    function _row(
        Bucket bucket,
        bytes32 id
    ) internal view returns (Listing storage row) {
        if (bucket == Bucket.Exact) return _exact[id];
        if (bucket == Bucket.Signature) return _signature[id];
        if (bucket == Bucket.Prompt) return _prompt[id];
        revert InvalidBucket(uint8(bucket));
    }
}

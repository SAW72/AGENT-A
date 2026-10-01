// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Denylist } from "../contracts/Denylist.sol";

contract DenylistTest is Test {
    Denylist internal d;

    uint256 internal constant T0 = 1_700_000_000;

    bytes32 internal constant WEIGHT = keccak256("weights");
    bytes32 internal constant SIG = keccak256("behavior");
    bytes32 internal constant PROMPT = keccak256("prompt");

    event Listed(
        bytes32 indexed id, Denylist.Bucket indexed bucket, address indexed actor, uint256 timestamp, uint64 timesListed
    );
    event Unlisted(
        bytes32 indexed id, Denylist.Bucket indexed bucket, address indexed actor, uint256 timestamp, uint64 timesListed
    );

    function setUp() public {
        vm.warp(T0);
        d = new Denylist();
    }

    function test_addExactAndCheck() public {
        d.addExact(WEIGHT);
        assertEq(uint256(d.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.ExactBlock));
        assertTrue(d.denylistedHashes(WEIGHT));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
    }

    function test_checkEmitsNothing() public {
        vm.recordLogs();
        Denylist.MatchLevel clean = d.check(WEIGHT, SIG, PROMPT);
        assertEq(uint256(clean), uint256(Denylist.MatchLevel.None));
        assertEq(vm.getRecordedLogs().length, 0);

        d.addPrompt(PROMPT);
        vm.recordLogs();
        Denylist.MatchLevel blocked = d.check(WEIGHT, SIG, PROMPT);
        assertEq(uint256(blocked), uint256(Denylist.MatchLevel.PromptBlock));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_addRejectsZeroId() public {
        vm.expectRevert(Denylist.ZeroId.selector);
        d.addExact(bytes32(0));
        vm.expectRevert(Denylist.ZeroId.selector);
        d.addSignature(bytes32(0));
        vm.expectRevert(Denylist.ZeroId.selector);
        d.addPrompt(bytes32(0));
        assertFalse(d.everListed(uint8(Denylist.Bucket.Exact), bytes32(0)));
        assertFalse(d.everListed(uint8(Denylist.Bucket.Signature), bytes32(0)));
        assertFalse(d.everListed(uint8(Denylist.Bucket.Prompt), bytes32(0)));
    }

    function test_removeRejectsZeroId() public {
        vm.expectRevert(Denylist.ZeroId.selector);
        d.remove(bytes32(0), uint8(Denylist.Bucket.Exact));
        vm.expectRevert(Denylist.ZeroId.selector);
        d.remove(bytes32(0), uint8(Denylist.Bucket.Signature));
        vm.expectRevert(Denylist.ZeroId.selector);
        d.remove(bytes32(0), uint8(Denylist.Bucket.Prompt));
    }

    function test_removeMissingReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Denylist.NotListed.selector, Denylist.Bucket.Exact, WEIGHT));
        d.remove(WEIGHT, uint8(Denylist.Bucket.Exact));
    }

    function test_doubleAddRevertsWithoutBumpingHistory() public {
        d.addExact(WEIGHT);
        vm.expectRevert(abi.encodeWithSelector(Denylist.AlreadyListed.selector, Denylist.Bucket.Exact, WEIGHT));
        d.addExact(WEIGHT);
        Denylist.Listing memory row = d.listing(uint8(Denylist.Bucket.Exact), WEIGHT);
        assertEq(row.timesListed, 1);
        assertTrue(row.active);
    }

    function test_unbanRecheckAndRebanPreservesHistory() public {
        _expectListed(WEIGHT, Denylist.Bucket.Exact, 1);
        d.addExact(WEIGHT);

        vm.warp(T0 + 1 days);
        _expectUnlisted(WEIGHT, Denylist.Bucket.Exact, 1);
        d.remove(WEIGHT, uint8(Denylist.Bucket.Exact));

        assertFalse(d.denylistedHashes(WEIGHT));
        assertEq(uint256(d.check(WEIGHT, bytes32(0), bytes32(0))), uint256(Denylist.MatchLevel.None));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));

        Denylist.Listing memory cleared = d.listing(uint8(Denylist.Bucket.Exact), WEIGHT);
        assertFalse(cleared.active);
        assertEq(cleared.timesListed, 1);
        assertEq(cleared.firstListedAt, T0);
        assertEq(cleared.lastListedAt, T0);
        assertEq(cleared.lastUnlistedAt, T0 + 1 days);
        assertEq(cleared.lastListedBy, address(this));
        assertEq(cleared.lastUnlistedBy, address(this));

        vm.warp(T0 + 2 days);
        _expectListed(WEIGHT, Denylist.Bucket.Exact, 2);
        d.addExact(WEIGHT);

        assertTrue(d.denylistedHashes(WEIGHT));
        assertEq(uint256(d.check(WEIGHT, bytes32(0), bytes32(0))), uint256(Denylist.MatchLevel.ExactBlock));
        Denylist.Listing memory relisted = d.listing(uint8(Denylist.Bucket.Exact), WEIGHT);
        assertTrue(relisted.active);
        assertEq(relisted.timesListed, 2);
        assertEq(relisted.firstListedAt, T0);
        assertEq(relisted.lastListedAt, T0 + 2 days);
        assertEq(relisted.lastUnlistedAt, T0 + 1 days);
        assertEq(relisted.lastListedBy, address(this));
    }

    function test_doubleRemoveRevertsAndKeepsCount() public {
        d.addSignature(SIG);
        d.remove(SIG, uint8(Denylist.Bucket.Signature));
        vm.expectRevert(abi.encodeWithSelector(Denylist.NotListed.selector, Denylist.Bucket.Signature, SIG));
        d.remove(SIG, uint8(Denylist.Bucket.Signature));
        assertEq(d.listing(uint8(Denylist.Bucket.Signature), SIG).timesListed, 1);
        assertTrue(d.everListed(uint8(Denylist.Bucket.Signature), SIG));
    }

    function test_removeIsScopedToBucket() public {
        d.addExact(WEIGHT);
        d.addPrompt(WEIGHT);
        d.remove(WEIGHT, uint8(Denylist.Bucket.Exact));

        assertFalse(d.denylistedHashes(WEIGHT));
        assertTrue(d.denylistedPrompts(WEIGHT));
        assertEq(uint256(d.check(bytes32(0), bytes32(0), WEIGHT)), uint256(Denylist.MatchLevel.PromptBlock));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Prompt), WEIGHT));
    }

    function test_checkPriorityAndPromptBlockName() public {
        d.addPrompt(PROMPT);
        d.addSignature(SIG);
        d.addExact(WEIGHT);

        assertEq(uint256(d.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.ExactBlock));

        d.remove(WEIGHT, uint8(Denylist.Bucket.Exact));
        assertEq(uint256(d.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.SignatureBlock));

        d.remove(SIG, uint8(Denylist.Bucket.Signature));
        assertEq(uint256(d.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.PromptBlock));
        assertTrue(d.denylistedPrompts(PROMPT));

        d.remove(PROMPT, uint8(Denylist.Bucket.Prompt));
        assertEq(uint256(d.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.None));
        assertFalse(d.denylistedPrompts(PROMPT));
        assertFalse(d.denylistedSignatures(SIG));
        assertFalse(d.denylistedHashes(WEIGHT));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Prompt), PROMPT));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Signature), SIG));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
    }

    function test_promptBlockOrdinalStaysOne() public pure {
        assertEq(uint256(Denylist.MatchLevel.None), 0);
        assertEq(uint256(Denylist.MatchLevel.PromptBlock), 1);
        assertEq(uint256(Denylist.MatchLevel.SignatureBlock), 2);
        assertEq(uint256(Denylist.MatchLevel.ExactBlock), 3);
    }

    function test_strangerCannotAddOrRemove() public {
        address eve = address(0xBAD);
        vm.startPrank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        d.addExact(WEIGHT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        d.addSignature(SIG);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        d.addPrompt(PROMPT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        d.remove(WEIGHT, uint8(Denylist.Bucket.Exact));
        vm.stopPrank();
    }

    function test_ownable2StepHandoffToTimelock() public {
        address timelock = address(0x71C0);
        d.transferOwnership(timelock);
        assertEq(d.owner(), address(this));
        assertEq(d.pendingOwner(), timelock);

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        d.acceptOwnership();

        vm.prank(timelock);
        d.acceptOwnership();
        assertEq(d.owner(), timelock);
        assertEq(d.pendingOwner(), address(0));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        d.addExact(WEIGHT);

        vm.prank(timelock);
        d.addExact(WEIGHT);
        assertTrue(d.denylistedHashes(WEIGHT));
        assertEq(d.listing(uint8(Denylist.Bucket.Exact), WEIGHT).lastListedBy, timelock);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        d.remove(WEIGHT, uint8(Denylist.Bucket.Exact));

        vm.prank(timelock);
        d.remove(WEIGHT, uint8(Denylist.Bucket.Exact));
        assertFalse(d.denylistedHashes(WEIGHT));
        assertEq(uint256(d.check(WEIGHT, bytes32(0), bytes32(0))), uint256(Denylist.MatchLevel.None));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
        assertEq(d.listing(uint8(Denylist.Bucket.Exact), WEIGHT).lastUnlistedBy, timelock);
    }

    function testFuzz_addRemovePreservesHistory(
        bytes32 id
    ) public {
        if (id == bytes32(0)) {
            vm.expectRevert(Denylist.ZeroId.selector);
            d.addExact(id);
            return;
        }

        d.addExact(id);
        assertTrue(d.denylistedHashes(id));
        d.remove(id, uint8(Denylist.Bucket.Exact));
        assertFalse(d.denylistedHashes(id));
        assertEq(uint256(d.check(id, bytes32(0), bytes32(0))), uint256(Denylist.MatchLevel.None));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Exact), id));
        assertEq(d.listing(uint8(Denylist.Bucket.Exact), id).timesListed, 1);

        d.addExact(id);
        assertEq(d.listing(uint8(Denylist.Bucket.Exact), id).timesListed, 2);
        assertEq(uint256(d.check(id, bytes32(0), bytes32(0))), uint256(Denylist.MatchLevel.ExactBlock));
    }

    function test_bucketSelectorsStayUint8() public pure {
        assertEq(uint8(Denylist.Bucket.Exact), 0);
        assertEq(uint8(Denylist.Bucket.Signature), 1);
        assertEq(uint8(Denylist.Bucket.Prompt), 2);
        assertEq(Denylist.remove.selector, bytes4(keccak256("remove(bytes32,uint8)")));
        assertEq(Denylist.listing.selector, bytes4(keccak256("listing(uint8,bytes32)")));
        assertEq(Denylist.everListed.selector, bytes4(keccak256("everListed(uint8,bytes32)")));
    }

    function test_invalidBucketRevertsAndDoesNotChangePrompt() public {
        d.addExact(WEIGHT);
        d.addSignature(SIG);
        d.addPrompt(PROMPT);

        Denylist.Listing memory promptBefore = d.listing(uint8(Denylist.Bucket.Prompt), PROMPT);
        assertTrue(promptBefore.active);
        assertEq(promptBefore.timesListed, 1);

        uint8[4] memory bad = [uint8(3), 4, 100, 255];
        for (uint256 i = 0; i < bad.length; i++) {
            _expectInvalidBucket(PROMPT, bad[i]);
            _expectInvalidBucket(WEIGHT, bad[i]);
        }

        Denylist.Listing memory promptAfter = d.listing(uint8(Denylist.Bucket.Prompt), PROMPT);
        assertTrue(promptAfter.active);
        assertEq(promptAfter.timesListed, promptBefore.timesListed);
        assertEq(promptAfter.firstListedAt, promptBefore.firstListedAt);
        assertEq(promptAfter.lastListedAt, promptBefore.lastListedAt);
        assertEq(promptAfter.lastUnlistedAt, promptBefore.lastUnlistedAt);
        assertEq(promptAfter.lastListedBy, promptBefore.lastListedBy);
        assertEq(promptAfter.lastUnlistedBy, promptBefore.lastUnlistedBy);
        assertTrue(d.denylistedPrompts(PROMPT));
        assertFalse(d.denylistedPrompts(WEIGHT));
        assertTrue(d.denylistedHashes(WEIGHT));
        assertTrue(d.denylistedSignatures(SIG));
        assertEq(uint256(d.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.ExactBlock));
    }

    function test_invalidBucketRawCalldataReverts() public {
        d.addPrompt(PROMPT);
        _rawInvalid(Denylist.remove.selector, abi.encode(PROMPT, uint8(3)), 3);
        _rawInvalid(Denylist.listing.selector, abi.encode(uint8(3), PROMPT), 3);
        _rawInvalid(Denylist.everListed.selector, abi.encode(uint8(9), PROMPT), 9);
        assertTrue(d.denylistedPrompts(PROMPT));
        Denylist.Listing memory row = d.listing(uint8(Denylist.Bucket.Prompt), PROMPT);
        assertTrue(row.active);
        assertEq(row.timesListed, 1);
        assertEq(row.lastListedBy, address(this));
    }

    function testFuzz_invalidBucketLeavesPromptStorage(
        uint8 bucket,
        bytes32 id
    ) public {
        vm.assume(bucket > uint8(Denylist.Bucket.Prompt));
        vm.assume(id != bytes32(0));
        d.addPrompt(id);

        vm.expectRevert(abi.encodeWithSelector(Denylist.InvalidBucket.selector, bucket));
        d.remove(id, bucket);
        vm.expectRevert(abi.encodeWithSelector(Denylist.InvalidBucket.selector, bucket));
        d.listing(bucket, id);
        vm.expectRevert(abi.encodeWithSelector(Denylist.InvalidBucket.selector, bucket));
        d.everListed(bucket, id);

        assertTrue(d.denylistedPrompts(id));
        assertEq(d.listing(uint8(Denylist.Bucket.Prompt), id).timesListed, 1);
        assertTrue(d.listing(uint8(Denylist.Bucket.Prompt), id).active);
    }

    function testFuzz_signatureAndPromptRoundTrip(
        bytes32 sig,
        bytes32 prompt
    ) public {
        vm.assume(sig != bytes32(0) && prompt != bytes32(0));

        d.addSignature(sig);
        d.addPrompt(prompt);
        assertEq(uint256(d.check(bytes32(0), sig, prompt)), uint256(Denylist.MatchLevel.SignatureBlock));

        d.remove(sig, uint8(Denylist.Bucket.Signature));
        assertEq(uint256(d.check(bytes32(0), sig, prompt)), uint256(Denylist.MatchLevel.PromptBlock));

        d.remove(prompt, uint8(Denylist.Bucket.Prompt));
        assertEq(uint256(d.check(bytes32(0), sig, prompt)), uint256(Denylist.MatchLevel.None));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Signature), sig));
        assertTrue(d.everListed(uint8(Denylist.Bucket.Prompt), prompt));
    }

    function _expectInvalidBucket(
        bytes32 id,
        uint8 bucket
    ) internal {
        vm.expectRevert(abi.encodeWithSelector(Denylist.InvalidBucket.selector, bucket));
        d.remove(id, bucket);
        vm.expectRevert(abi.encodeWithSelector(Denylist.InvalidBucket.selector, bucket));
        d.listing(bucket, id);
        vm.expectRevert(abi.encodeWithSelector(Denylist.InvalidBucket.selector, bucket));
        d.everListed(bucket, id);
    }

    function _rawInvalid(
        bytes4 selector,
        bytes memory args,
        uint8 bucket
    ) internal {
        (bool ok, bytes memory ret) = address(d).call(abi.encodePacked(selector, args));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(Denylist.InvalidBucket.selector, bucket));
    }

    function _expectListed(
        bytes32 id,
        Denylist.Bucket bucket,
        uint64 times
    ) internal {
        vm.expectEmit(true, true, true, true, address(d));
        emit Listed(id, bucket, address(this), block.timestamp, times);
    }

    function _expectUnlisted(
        bytes32 id,
        Denylist.Bucket bucket,
        uint64 times
    ) internal {
        vm.expectEmit(true, true, true, true, address(d));
        emit Unlisted(id, bucket, address(this), block.timestamp, times);
    }
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import {
  assertDenylistBucket,
  denylistBucketName,
  denylistBucketOrdinal,
  isValidDenylistBucket,
} from "../denylistBucket.mjs";
import { decodeBusinessLog, encodeEventData, eventByName } from "../reputation/codec.mjs";
import { createDefaultHooks, recordingEnforcer } from "../reputation/hooks.mjs";
import { replayLedger } from "../reputation/replay.mjs";
import { BLOCK0, DENYLIST, addr, businessLog, bytes32, dayTs } from "./reputationFixture.mjs";

const OPERATOR = addr(0xaa);

function rawDenylistLog(eventName, bucket, { blockNumber, logIndex = 0 } = {}) {
  const event = eventByName(eventName);
  const args = {
    id: bytes32(9),
    bucket,
    actor: OPERATOR,
    timestamp: BigInt(dayTs(80, 1)),
    timesListed: 1n,
  };
  const topics = encodeEventTopics({ abi: [event.item], eventName, args });
  const data = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint64" },
    ],
    [args.timestamp, args.timesListed],
  );
  return {
    address: DENYLIST,
    topics,
    data,
    blockNumber,
    logIndex,
    blockTimestamp: dayTs(80, 1),
    transactionHash: bytes32(0x9100 + blockNumber),
    blockHash: bytes32(0x9200n + BigInt(blockNumber)),
  };
}

describe("Denylist bucket validator", () => {
  it("accepts only Exact 0, Signature 1, and Prompt 2", () => {
    assert.deepEqual(assertDenylistBucket(0), { value: 0, name: "Exact" });
    assert.deepEqual(assertDenylistBucket(1n), { value: 1, name: "Signature" });
    assert.deepEqual(assertDenylistBucket("2"), { value: 2, name: "Prompt" });
    assert.equal(denylistBucketName(0), "Exact");
    assert.equal(denylistBucketName(1), "Signature");
    assert.equal(denylistBucketName(2), "Prompt");
    assert.equal(isValidDenylistBucket(2), true);
  });

  it("does not map an out-of-range value to Prompt", () => {
    for (const value of [3, 4, 255, -1, 1.5, "Prompt", "02", 256n, null, undefined]) {
      assert.equal(denylistBucketName(value), null, String(value));
      assert.equal(isValidDenylistBucket(value), false);
      assert.throws(
        () => assertDenylistBucket(value),
        (err) => err.error === "invalid_bucket" && err.bucket === value,
      );
    }
    assert.equal(denylistBucketOrdinal(3), 3);
    assert.equal(denylistBucketOrdinal(255), 255);
    assert.equal(denylistBucketOrdinal(256), null);
  });

  it("rejects an out-of-range bucket before encoding Listed or Unlisted topics", () => {
    assert.throws(
      () =>
        encodeEventData("Listed", {
          id: bytes32(9),
          bucket: 3,
          actor: OPERATOR,
          timestamp: 1n,
          timesListed: 1n,
        }),
      (err) => err.error === "invalid_bucket" && err.bucket === 3,
    );
    assert.throws(
      () =>
        encodeEventData("Unlisted", {
          id: bytes32(9),
          bucket: 255,
          actor: OPERATOR,
          timestamp: 1n,
          timesListed: 1n,
        }),
      (err) => err.error === "invalid_bucket",
    );
    const encoded = encodeEventData("Listed", {
      id: bytes32(9),
      bucket: 2,
      actor: OPERATOR,
      timestamp: 1n,
      timesListed: 1n,
    });
    assert.equal(decodeBusinessLog(encoded).args.bucket, 2);
  });

  it("flags a decoded out-of-range bucket and still accepts 0, 1, and 2", () => {
    const logs = [
      rawDenylistLog("Listed", 3, { blockNumber: BLOCK0 + 1, logIndex: 0 }),
      rawDenylistLog("Unlisted", 255, { blockNumber: BLOCK0 + 2, logIndex: 0 }),
      businessLog({
        event: "Listed",
        address: DENYLIST,
        args: { id: bytes32(3), bucket: 0, actor: OPERATOR, timestamp: BigInt(dayTs(80, 1)), timesListed: 1n },
        blockNumber: BLOCK0 + 3,
        timestamp: dayTs(80, 1),
      }),
      businessLog({
        event: "Listed",
        address: DENYLIST,
        args: { id: bytes32(4), bucket: 1, actor: OPERATOR, timestamp: BigInt(dayTs(80, 1)), timesListed: 1n },
        blockNumber: BLOCK0 + 4,
        timestamp: dayTs(80, 1),
      }),
      businessLog({
        event: "Unlisted",
        address: DENYLIST,
        args: { id: bytes32(5), bucket: 2, actor: OPERATOR, timestamp: BigInt(dayTs(80, 1)), timesListed: 1n },
        blockNumber: BLOCK0 + 5,
        timestamp: dayTs(80, 1),
      }),
    ];
    const decodedBad = decodeBusinessLog(logs[0]);
    assert.equal(decodedBad.args.bucket, 3);
    assert.equal(denylistBucketName(decodedBad.args.bucket), null);

    const result = replayLedger({
      chainId: 84532,
      logs,
      safeBlock: BLOCK0 + 100,
      finalizedBlock: BLOCK0 + 100,
      hooks: { ...createDefaultHooks(), enforcer: recordingEnforcer({ withholdOn: ["DENYLIST_LISTED", "DENYLIST_INVALID_BUCKET", "DENYLIST_UNLISTED"] }) },
    });
    const invalid = result.signals.filter((signal) => signal.kind === "DENYLIST_INVALID_BUCKET");
    assert.deepEqual(
      invalid.map((signal) => signal.bucket),
      [3, 255],
    );
    assert.equal(invalid.every((signal) => signal.bucket !== 2 && signal.wallet === null), true);
    const flags = result.enforcer_flags.filter((signal) => signal.kind === "DENYLIST_INVALID_BUCKET");
    assert.equal(flags.length, 2);
    assert.equal(flags.every((signal) => signal.withhold_wallet === false), true);
    assert.equal(result.signals.filter((signal) => signal.kind === "DENYLIST_LISTED").length, 2);
    assert.equal(result.signals.filter((signal) => signal.kind === "DENYLIST_UNLISTED").length, 1);
    assert.equal(result.entries.length, 0);
  });
});

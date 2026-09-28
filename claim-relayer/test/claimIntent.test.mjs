import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { keccak256, toBytes } from "viem";
import { CLAIM_INTENT_SCHEMA, CLAIM_INTENT_TYPE_STRING, CLAIM_INTENT_TYPEHASH, actionIndex, actionName, parseClaimIntent } from "../claimIntent.mjs";

/** Pinned EIP-712 typehash for ClaimIntent. A schema edit must change this on purpose. */
const PINNED_TYPEHASH = "0x1f13fdcc6f1390de5e43ffa26909f5e100cb78aaa1cf33d9abdf7d71a4cde0d2";

describe("ClaimIntent typehash", () => {
  it("pins the EIP-712 type string and typehash", () => {
    assert.equal(
      CLAIM_INTENT_TYPE_STRING,
      "ClaimIntent(uint8 action,bytes32 escrowId,address sender,uint256 nonce,uint256 deadline)",
    );
    assert.equal(CLAIM_INTENT_TYPEHASH, keccak256(toBytes(CLAIM_INTENT_TYPE_STRING)));
    assert.equal(CLAIM_INTENT_TYPEHASH, PINNED_TYPEHASH);
    assert.equal(CLAIM_INTENT_SCHEMA.domainName, "AgentBV Claim Relayer");
    assert.equal(CLAIM_INTENT_SCHEMA.domainVersion, "1");
    assert.deepEqual(CLAIM_INTENT_SCHEMA.actions, ["refund"]);
    assert.deepEqual(CLAIM_INTENT_SCHEMA.actionValues, { refund: 1 });
    assert.deepEqual(CLAIM_INTENT_SCHEMA.refusedActions, { release: 0 });
    assert.equal(actionIndex("refund"), 1);
    assert.equal(actionIndex(1), 1);
    assert.equal(actionName(1), "refund");
    assert.equal(actionIndex("release"), 0);
    assert.equal(actionIndex(0), 0);
    assert.equal(actionName(0), "release");
    assert.equal(CLAIM_INTENT_SCHEMA.actions.includes("release"), false);
    assert.equal(CLAIM_INTENT_SCHEMA.typeString.includes("calldata"), false);
    assert.equal(CLAIM_INTENT_SCHEMA.deadlineWindowSeconds, 300);
  });

  it("refuses release before a signature is read", () => {
    for (const action of ["release", 0]) {
      assert.throws(
        () => parseClaimIntent({ intent: { action } }),
        (err) => err.status === 400 && err.error === "release_not_relayable",
      );
    }
  });

  it("loads the same JSON bytes the wallet reads", () => {
    const fromDisk = readFileSync(new URL("../claimIntent.json", import.meta.url), "utf8");
    assert.deepEqual(JSON.parse(fromDisk), CLAIM_INTENT_SCHEMA);
    assert.equal(fromDisk.includes("AgentBV Claim Relayer"), true);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { keccak256, toBytes } from "viem";
import { CLAIM_INTENT_SCHEMA, CLAIM_INTENT_TYPE_STRING, CLAIM_INTENT_TYPEHASH } from "../claimIntent.mjs";

/** Pinned EIP-712 typehash for ClaimIntent. A schema edit must change this on purpose. */
const PINNED_TYPEHASH = "0x34ba3a41e51e53513e455b5e4bc91be46317c71f0430096556c954dc76195242";

describe("ClaimIntent typehash", () => {
  it("pins the EIP-712 type string and typehash", () => {
    assert.equal(
      CLAIM_INTENT_TYPE_STRING,
      "ClaimIntent(uint8 action,bytes32 escrowId,bytes32 calldataHash,address sender,uint256 nonce,uint256 deadline)",
    );
    assert.equal(CLAIM_INTENT_TYPEHASH, keccak256(toBytes(CLAIM_INTENT_TYPE_STRING)));
    assert.equal(CLAIM_INTENT_TYPEHASH, PINNED_TYPEHASH);
    assert.equal(CLAIM_INTENT_SCHEMA.domainName, "AgentBV Claim Relayer");
    assert.equal(CLAIM_INTENT_SCHEMA.domainVersion, "1");
    assert.deepEqual(CLAIM_INTENT_SCHEMA.actions, ["createEscrow", "release", "refund", "dispute"]);
    assert.equal(CLAIM_INTENT_SCHEMA.deadlineWindowSeconds, 300);
  });

  it("loads the same JSON bytes the wallet reads", () => {
    const fromDisk = readFileSync(new URL("../claimIntent.json", import.meta.url), "utf8");
    assert.deepEqual(JSON.parse(fromDisk), CLAIM_INTENT_SCHEMA);
    assert.equal(fromDisk.includes("AgentBV Claim Relayer"), true);
  });
});

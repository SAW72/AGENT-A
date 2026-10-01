import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNonceStore } from "../nonceStore.mjs";

describe("nonce reservation", () => {
  it("gives concurrent claims distinct nonces and refreshes the same claimId", async () => {
    let clock = 1_000;
    const store = createNonceStore({ now: () => clock, initialNonce: 4 });
    const [a, b] = await Promise.all([
      store.reserve({ claimId: "claim-a", ttlMs: 50, atMs: clock }),
      store.reserve({ claimId: "claim-b", ttlMs: 50, atMs: clock }),
    ]);
    assert.notEqual(a.nonce.toString(), b.nonce.toString());
    const again = await store.reserve({ claimId: "claim-a", ttlMs: 50, atMs: clock });
    assert.equal(again.nonce.toString(), a.nonce.toString());
    assert.equal(store.markConsumed(a.nonce), true);
    assert.equal(store.release(a.nonce), false);
    clock = 10_000;
    const afterExpiry = await store.reserve({ claimId: "claim-b", ttlMs: 50, atMs: clock });
    assert.notEqual(afterExpiry.nonce.toString(), b.nonce.toString());
  });

  it("does not reuse a released nonce below the counter", async () => {
    const store = createNonceStore({ initialNonce: 0 });
    const first = await store.reserve({ claimId: "one", ttlMs: 1000, atMs: 1 });
    assert.equal(store.release(first.nonce), true);
    const second = await store.reserve({ claimId: "two", ttlMs: 1000, atMs: 1 });
    assert.equal(second.nonce, first.nonce + 1n);
    assert.equal(store.peek(first.nonce), null);
  });
});

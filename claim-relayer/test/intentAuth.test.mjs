import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { keccak256 } from "viem";
import { createAbuseGuard } from "../abuseLimits.mjs";
import { createClaimRelayer } from "../app.mjs";
import { RETIRED_ESCROW } from "../claimIntent.mjs";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { encodeEscrowAction } from "../escrowCalldata.mjs";
import { createMemoryIntentNonceStore } from "../intentNonceStore.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { BOOKED_ESCROW, NOW_MS, deadlineAt, signedLiveBody, testAccounts, trackingChain } from "./liveIntent.mjs";

const TX = "0x" + "ab".repeat(32);

function request(port, method, path, body, headers = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot(env = {}, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "intent-auth-"));
  const config = loadConfig({
    CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
    LIVE_SUBMIT: "1",
    SPENCER_RUN_AUTH: "1",
    ...env,
  });
  const sent = [];
  const chain = extra.chain || trackingChain({ exists: false });
  const server = createClaimRelayer({
    config,
    killSwitch: createKillSwitch({ initial: false }),
    nonceStore: createNonceStore(),
    intentNonces: extra.intentNonces || createMemoryIntentNonceStore({ now: () => NOW_MS }),
    abuse: extra.abuse || createAbuseGuard(config.abuse, { now: () => NOW_MS }),
    chain,
    claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
    broadcaster: extra.broadcaster || {
      async send(tx) {
        sent.push(tx);
        return { txHash: TX };
      },
    },
    now: () => NOW_MS,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    sent,
    chain,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function releaseBody(account, opts = {}) {
  return signedLiveBody({
    account,
    action: opts.action || "release",
    escrowId: opts.escrowId || "0x" + "11".repeat(32),
    nonce: opts.nonce || "7",
    deadline: opts.deadline || deadlineAt(120),
    chainId: opts.chainId,
    verifyingContract: opts.verifyingContract,
    calldata: opts.calldata,
    fields: opts.fields,
  });
}

describe("signed claim intent auth", () => {
  const accounts = testAccounts();
  const escrowId = "0x" + "11".repeat(32);

  it("rejects a non-party signature with 403 and does not broadcast", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.stranger, { nonce: "101" });
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 403);
      assert.equal(res.json.error, "not_a_party");
      assert.equal(ctx.sent.length, 0);
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(chain.calls.reads.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("rejects a wrong chain id and the retired escrow before any escrow read", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const wrongChain = await releaseBody(accounts.payer, { nonce: "102", chainId: 1 });
      const chainRes = await request(ctx.port, "POST", "/v1/claims", wrongChain);
      assert.equal(chainRes.status, 400);
      assert.equal(chainRes.json.error, "mainnet_refused");

      const otherChain = await releaseBody(accounts.payer, { nonce: "103", chainId: 11155111 });
      const otherRes = await request(ctx.port, "POST", "/v1/claims", otherChain);
      assert.equal(otherRes.status, 400);
      assert.equal(otherRes.json.error, "wrong_chain");

      const retired = await releaseBody(accounts.payer, { nonce: "104", verifyingContract: RETIRED_ESCROW });
      const retiredRes = await request(ctx.port, "POST", "/v1/claims", retired);
      assert.equal(retiredRes.status, 400);
      assert.equal(retiredRes.json.error, "retired_or_superseded_address");

      const otherEscrow = "0x3333333333333333333333333333333333333333";
      const mismatch = await releaseBody(accounts.payer, { nonce: "105", verifyingContract: otherEscrow });
      const mismatchRes = await request(ctx.port, "POST", "/v1/claims", mismatch);
      assert.equal(mismatchRes.status, 409);
      assert.equal(mismatchRes.json.error, "domain_mismatch");
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("rejects an expired deadline and a deadline past the 300 second window", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const expired = await releaseBody(accounts.payer, { nonce: "106", deadline: deadlineAt(0) });
      const expiredRes = await request(ctx.port, "POST", "/v1/claims", expired);
      assert.equal(expiredRes.status, 400);
      assert.equal(expiredRes.json.error, "deadline_expired");

      const past = await releaseBody(accounts.payer, { nonce: "107", deadline: deadlineAt(-5) });
      const pastRes = await request(ctx.port, "POST", "/v1/claims", past);
      assert.equal(pastRes.status, 400);
      assert.equal(pastRes.json.error, "deadline_expired");

      const far = await releaseBody(accounts.payer, { nonce: "108", deadline: deadlineAt(301) });
      const farRes = await request(ctx.port, "POST", "/v1/claims", far);
      assert.equal(farRes.status, 400);
      assert.equal(farRes.json.error, "deadline_too_far");

      const edge = await releaseBody(accounts.payer, { nonce: "109", deadline: deadlineAt(300) });
      const edgeRes = await request(ctx.port, "POST", "/v1/claims", edge);
      assert.equal(edgeRes.status, 200);
      assert.equal(edgeRes.json.txHash, TX);
      assert.equal(chain.calls.reads.length, 1);
      assert.equal(ctx.sent.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("returns the original tx hash for a replayed nonce and does not broadcast again", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "110" });
      const first = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(first.status, 200);
      assert.equal(first.json.txHash, TX);
      assert.equal(first.json.replay, undefined);
      const second = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(second.status, 200);
      assert.equal(second.json.txHash, TX);
      assert.equal(second.json.replay, true);
      assert.equal(ctx.sent.length, 1);
      assert.equal(chain.calls.simulations.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("rejects a calldata hash mismatch and a disallowed selector", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "111" });
      body.calldata = "0x" + "ee".repeat(36);
      const mismatch = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(mismatch.status, 400);
      assert.equal(mismatch.json.error, "calldata_hash_mismatch");
      assert.equal(chain.calls.reads.length, 1);
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(ctx.sent.length, 0);

      const badCalldata = "0xdeadbeef" + "ab".repeat(32);
      const bad = await releaseBody(accounts.payer, { nonce: "112", calldata: badCalldata });
      const selector = await request(ctx.port, "POST", "/v1/claims", bad);
      assert.equal(selector.status, 400);
      assert.equal(selector.json.error, "selector_not_allowed");
      assert.equal(ctx.sent.length, 0);
      assert.equal(keccak256(badCalldata), bad.intent.calldataHash);
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 escrow_not_found before simulation when the id does not exist", async () => {
    const chain = trackingChain({ exists: false, payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "113" });
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 404);
      assert.equal(res.json.error, "escrow_not_found");
      assert.equal(chain.calls.simulations.length, 0);
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("checks domain and deadline before signature recovery", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "114", chainId: 8453 });
      body.signature = "0x" + "11".repeat(65);
      const res = await request(ctx.port, "POST", "/v1/claims", body);
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "mainnet_refused");
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(chain.calls.reads.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("uses ERC-1271 only when the flag is on", async () => {
    const chain = trackingChain({
      payer: accounts.payer.address,
      payee: accounts.payee.address,
      isValidSignature: (account) => account.toLowerCase() === accounts.payer.address.toLowerCase(),
    });
    const off = await boot({}, { chain });
    try {
      const body = await releaseBody(accounts.payer, { nonce: "115" });
      body.signature = "0x" + "22".repeat(65);
      const refused = await request(off.port, "POST", "/v1/claims", body);
      assert.equal(refused.status, 401);
      assert.equal(refused.json.error, "invalid_signature");
      assert.equal(chain.calls.erc1271.length, 0);
      assert.equal(chain.calls.reads.length, 0);
      assert.equal(off.sent.length, 0);
    } finally {
      await off.close();
    }

    const onChain = trackingChain({
      payer: accounts.payer.address,
      payee: accounts.payee.address,
      isValidSignature: (account) => account.toLowerCase() === accounts.payer.address.toLowerCase(),
    });
    const on = await boot({ ERC1271_ENABLED: "1" }, { chain: onChain });
    try {
      const encoded = encodeEscrowAction({ action: "release", claimId: escrowId });
      const body = await releaseBody(accounts.payer, { nonce: "116", calldata: encoded.calldata });
      body.signature = "0x" + "33".repeat(80);
      const accepted = await request(on.port, "POST", "/v1/claims", body);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.json.txHash, TX);
      assert.equal(onChain.calls.erc1271.length, 1);
      assert.equal(on.sent.length, 1);
    } finally {
      await on.close();
    }
  });

  it("enforces per-sender, per-IP, and per-escrow limits", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot(
      { CLAIM_RATE_SENDER: "1", CLAIM_RATE_IP: "1", CLAIM_ESCROW_CAP: "1" },
      { chain },
    );
    try {
      const first = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "201" }),
      );
      assert.equal(first.status, 200);
      const second = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "202" }),
      );
      assert.equal(second.status, 429);
      assert.equal(second.json.error, "rate_limited");
      assert.equal(ctx.sent.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("stops a second party on the same escrow when the escrow cap is the only limit", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({ CLAIM_RATE_SENDER: "10", CLAIM_RATE_IP: "10", CLAIM_ESCROW_CAP: "1" }, { chain });
    try {
      const payer = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "301" }),
        { "x-forwarded-for": "203.0.113.10" },
      );
      assert.equal(payer.status, 200);
      const payee = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payee, { nonce: "302", action: "refund" }),
        { "x-forwarded-for": "203.0.113.11" },
      );
      assert.equal(payee.status, 429);
      assert.equal(payee.json.error, "escrow_cap");
      assert.equal(ctx.sent.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it("refuses a claim that would exhaust the daily gas budget", async () => {
    const chain = trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address });
    const ctx = await boot({ DAILY_GAS_BUDGET_WEI: "1", CLAIM_GAS_PRICE_WEI: "1000000000" }, { chain });
    try {
      const res = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        await releaseBody(accounts.payer, { nonce: "401" }),
      );
      assert.equal(res.status, 429);
      assert.equal(res.json.error, "gas_budget_exhausted");
      assert.equal(ctx.sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("keeps the kill switch in front of signature checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intent-auth-"));
    const config = loadConfig({
      CLAIM_LOG_PATH: join(dir, "claims.jsonl"),
      LIVE_SUBMIT: "1",
      SPENCER_RUN_AUTH: "1",
      KILL_SWITCH: "1",
    });
    const sent = [];
    const server = createClaimRelayer({
      config,
      killSwitch: createKillSwitch({ initial: true }),
      nonceStore: createNonceStore(),
      intentNonces: createMemoryIntentNonceStore({ now: () => NOW_MS }),
      abuse: createAbuseGuard(config.abuse, { now: () => NOW_MS }),
      chain: trackingChain({ payer: accounts.payer.address, payee: accounts.payee.address }),
      claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
      broadcaster: {
        async send(tx) {
          sent.push(tx);
          return { txHash: TX };
        },
      },
      now: () => NOW_MS,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const res = await request(server.address().port, "POST", "/v1/claims", { live: true });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, "kill_switch");
      assert.equal(sent.length, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("uses the booked escrow as the verifying contract", () => {
    assert.equal(BOOKED_ESCROW.toLowerCase(), "0x1069aa6597f08f1e8b8ad39aa40ede1d0c77298d");
  });
});

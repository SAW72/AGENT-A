import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClaimRelayer } from "../app.mjs";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";

const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const SECRET = "0x" + "cd".repeat(32);
const CLAIM_SECRET = "claim-api-test-secret";
const claimHeaders = { "x-claim-secret": CLAIM_SECRET };

describe("claim relayer HTTP", () => {
  it("serves fixture health, quote, and claim without leaking a key", async () => {
    const ctx = await boot();
    try {
      const health = await request(ctx.port, "GET", "/health");
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(health.json.chainId, 84532);
      assert.equal(health.json.killSwitch, false);
      assert.equal(health.json.mode, "fixture");
      assert.equal(health.json.stub, true);
      assert.equal(health.json.fixture, true);
      assert.equal(health.json.escrowBooked, true);
      assert.equal(health.json.escrowSource, "address_book");
      assert.equal(health.json.escrowAddress, "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d");
      assert.deepEqual(health.json.liveSubmitBlockers, ["spencer_run_auth_required", "live_submit_off"]);
      assert.equal(health.json.relayerAddress, "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861");
      assert.equal(health.json.liveSubmit, false);
      assert.equal(JSON.stringify(health.json).includes(SECRET), false);
      assert.equal(JSON.stringify(health.json).toLowerCase().includes("private"), false);

      const quote = await request(ctx.port, "POST", "/v1/claims/quote", {
        payer: PAYER,
        payee: PAYEE,
        claimId: "claim-1",
        privateKey: SECRET,
      });
      assert.equal(quote.status, 200);
      assert.equal(quote.json.fixture, true);
      assert.equal(quote.json.claimId, "claim-1");
      assert.equal(quote.json.payer, PAYER);
      assert.equal(quote.json.payee, PAYEE);
      assert.equal(quote.json.chainId, 84532);
      assert.equal(quote.json.mode, "fixture");
      assert.equal(quote.json.relayerNonce, "0");
      assert.equal("amountWei" in quote.json, false);
      assert.equal(Number.isNaN(Date.parse(quote.json.expiresAt)), false);
      assert.equal(JSON.stringify(quote.json).includes(SECRET), false);

      const claim = await request(ctx.port, "POST", "/v1/claims", {
        claimId: "claim-1",
        payer: PAYER,
        payee: PAYEE,
        amountWei: "1000",
      });
      assert.equal(claim.status, 200);
      assert.equal(claim.json.ok, true);
      assert.equal(claim.json.mode, "fixture");
      assert.equal(claim.json.claimId, "claim-1");
      assert.equal(claim.json.txHash, null);
      assert.equal(claim.json.reason, "escrow_booked_spencer_run_auth_required");
      assert.equal(claim.json.dryRun, true);
      assert.equal(claim.json.escrowBooked, true);
      assert.equal(claim.json.calldata, null);
      assert.equal(claim.json.calldataStatus, "action_required");

      const echoed = await request(ctx.port, "POST", "/v1/claims/quote", {
        payer: PAYER,
        payee: PAYEE,
        claimId: "claim-2",
        amountWei: "1000",
      });
      assert.equal(echoed.json.amountWei, "1000");

      const log = await readFile(ctx.logPath, "utf8");
      assert.equal(log.includes(SECRET), false);
      assert.equal(log.includes("claim_fixture"), true);
    } finally {
      await ctx.close();
    }
  });

  it("encodes release calldata and still returns a null tx hash", async () => {
    const ctx = await boot();
    const escrowId = "0x" + "11".repeat(32);
    try {
      const claim = await request(ctx.port, "POST", "/v1/claims", { action: "release", claimId: escrowId });
      assert.equal(claim.status, 200);
      assert.equal(claim.json.ok, true);
      assert.equal(claim.json.txHash, null);
      assert.equal(claim.json.action, "release");
      assert.equal(claim.json.signature, "release(bytes32)");
      assert.equal(claim.json.calldataStatus, "encoded");
      assert.equal(claim.json.valueWei, "0");
      assert.equal(claim.json.senderConstraint, "permissionless");
      assert.equal(claim.json.calldata, claim.json.selector + escrowId.slice(2));
      assert.equal(claim.json.reason, "escrow_booked_spencer_run_auth_required");
    } finally {
      await ctx.close();
    }
  });

  it("returns kill_switch and live_submit_blocked", async () => {
    const ctx = await boot({ KILL_SWITCH: "1", ADMIN_SECRET: "admin-test" });
    try {
      const health = await request(ctx.port, "GET", "/v1/health");
      assert.equal(health.status, 200);
      assert.equal(health.json.killSwitch, true);

      const blocked = await request(ctx.port, "POST", "/v1/claims/quote", {
        payer: PAYER,
        payee: PAYEE,
      });
      assert.equal(blocked.status, 503);
      assert.equal(blocked.json.error, "kill_switch");

      const claimBlocked = await request(ctx.port, "POST", "/v1/claims", { claimId: "claim-1" });
      assert.equal(claimBlocked.status, 503);
      assert.equal(claimBlocked.json.error, "kill_switch");

      const unpause = await request(ctx.port, "POST", "/v1/admin/unpause", {}, { "x-admin-secret": "admin-test" });
      assert.equal(unpause.status, 200);
      assert.equal(unpause.json.killSwitch, false);

      const live = await request(ctx.port, "POST", "/v1/claims", { claimId: "claim-1", live: true });
      assert.equal(live.status, 409);
      assert.equal(live.json.ok, false);
      assert.equal(live.json.error, "live_submit_blocked");
      assert.equal(live.json.txHash, null);
      assert.equal(live.json.reason, "escrow_booked_spencer_run_auth_required");
      assert.deepEqual(live.json.blockers, ["spencer_run_auth_required", "live_submit_off"]);

      const mainnet = await request(ctx.port, "POST", "/v1/claims/quote", {
        payer: PAYER,
        payee: PAYEE,
        chainId: 1,
      });
      assert.equal(mainnet.status, 400);
      assert.equal(mainnet.json.error, "mainnet_refused");

      const other = await request(ctx.port, "POST", "/v1/claims", { claimId: "claim-1", chainId: 11155111 });
      assert.equal(other.status, 400);
      assert.equal(other.json.error, "wrong_chain");
    } finally {
      await ctx.close();
    }
  });

  it("documents a no-op admin route when ADMIN_SECRET is unset", async () => {
    const ctx = await boot({ KILL_SWITCH: "0" });
    try {
      const pause = await request(ctx.port, "POST", "/v1/admin/pause", {}, { "x-admin-secret": "nope" });
      assert.equal(pause.status, 200);
      assert.equal(pause.json.noop, true);
      assert.equal(pause.json.killSwitch, false);
      assert.match(pause.json.docs, /ADMIN_SECRET is unset/);
      const health = await request(ctx.port, "GET", "/health");
      assert.equal(health.json.killSwitch, false);
    } finally {
      await ctx.close();
    }
  });

  it("refuses live submit when the escrow address is not the booked Sepolia contract", async () => {
    const sent = [];
    const ctx = await boot(
      {
        ESCROW_ADDRESS: "0x3333333333333333333333333333333333333333",
        LIVE_SUBMIT: "1",
        SPENCER_RUN_AUTH: "1",
        RELAYER_PRIVATE_KEY: SECRET,
      },
      {
        broadcaster: {
          async send(tx) {
            sent.push(tx);
            return { txHash: "0x" + "ab".repeat(32) };
          },
        },
      },
    );
    try {
      const health = await request(ctx.port, "GET", "/health");
      assert.equal(health.json.escrowBooked, true);
      assert.equal(health.json.escrowAddress, "0x3333333333333333333333333333333333333333");
      assert.equal(health.json.liveSubmit, false);
      assert.equal(health.json.mode, "fixture");
      assert.equal(health.json.liveSubmitRequested, true);
      assert.deepEqual(health.json.liveSubmitBlockers, ["escrow_not_booked_sepolia"]);
      assert.equal(JSON.stringify(health.json).includes(SECRET), false);

      const claim = await request(ctx.port, "POST", "/v1/claims", { claimId: "claim-booked", mode: "live" });
      assert.equal(claim.status, 409);
      assert.equal(claim.json.error, "live_submit_blocked");
      assert.equal(claim.json.reason, "escrow_not_booked_sepolia");
      assert.equal(claim.json.txHash, null);
      assert.equal(sent.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it("broadcasts a Sepolia escrow action when Spencer unlocks live submit", async () => {
    const sent = [];
    const txHash = "0x" + "ab".repeat(32);
    const ctx = await boot(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1", RELAYER_PRIVATE_KEY: SECRET, CLAIM_API_SECRET: CLAIM_SECRET },
      {
        broadcaster: {
          async send(tx) {
            sent.push(tx);
            return { txHash };
          },
        },
      },
    );
    const escrowId = "0x" + "11".repeat(32);
    try {
      const health = await request(ctx.port, "GET", "/health");
      assert.equal(health.json.liveSubmit, true);
      assert.equal(health.json.mode, "live");
      assert.equal(health.json.fixture, false);
      assert.equal(health.json.stub, false);
      assert.deepEqual(health.json.liveSubmitBlockers, []);
      assert.equal(JSON.stringify(health.json).includes(SECRET), false);

      const claim = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        {
          action: "release",
          claimId: escrowId,
          live: true,
        },
        claimHeaders,
      );
      assert.equal(claim.status, 200);
      assert.equal(claim.json.ok, true);
      assert.equal(claim.json.mode, "live");
      assert.equal(claim.json.txHash, txHash);
      assert.equal(claim.json.dryRun, false);
      assert.equal(claim.json.fixture, false);
      assert.equal(claim.json.senderConstraint, "permissionless");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].chainId, 84532);
      assert.equal(sent[0].to, "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d");
      assert.equal(sent[0].valueWei, "0");
      assert.equal(JSON.stringify(claim.json).includes(SECRET), false);

      const dry = await request(ctx.port, "POST", "/v1/claims", { action: "release", claimId: escrowId });
      assert.equal(dry.status, 200);
      assert.equal(dry.json.mode, "fixture");
      assert.equal(dry.json.txHash, null);
      assert.equal(dry.json.reason, "dry_run");
      assert.equal(sent.length, 1);

      const quote = await request(ctx.port, "POST", "/v1/claims/quote", {
        payer: PAYER,
        payee: PAYEE,
        live: true,
      });
      assert.equal(quote.status, 409);
      assert.equal(quote.json.reason, "quote_does_not_broadcast");
      assert.equal(sent.length, 1);

      const mainnet = await request(ctx.port, "POST", "/v1/claims", {
        action: "release",
        claimId: escrowId,
        live: true,
        chainId: 8453,
      });
      assert.equal(mainnet.status, 400);
      assert.equal(mainnet.json.error, "mainnet_refused");
      assert.equal(sent.length, 1);

      const ethereum = await request(ctx.port, "POST", "/v1/claims", {
        action: "release",
        claimId: escrowId,
        mode: "broadcast",
        chainId: 1,
      });
      assert.equal(ethereum.status, 400);
      assert.equal(ethereum.json.error, "mainnet_refused");
      assert.equal(sent.length, 1);

      const created = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        {
          action: "createEscrow",
          claimId: "0x" + "33".repeat(32),
          payee: PAYEE,
          payerBotId: "0x" + "44".repeat(32),
          payeeBotId: "0x" + "55".repeat(32),
          durationSeconds: "3600",
          amountWei: "1000",
          live: true,
        },
        claimHeaders,
      );
      assert.equal(created.status, 200);
      assert.equal(created.json.txHash, txHash);
      assert.equal(created.json.valueWei, "1000");
      assert.equal(created.json.senderConstraint, "vault_operator_must_send");
      assert.match(created.json.senderNote, /Vault operator/);
      assert.equal(sent.at(-1).action, "createEscrow");
      assert.equal(sent.at(-1).valueWei, "1000");
      assert.equal(sent.at(-1).chainId, 84532);

      const log = await readFile(ctx.logPath, "utf8");
      assert.equal(log.includes(SECRET), false);
      assert.equal(log.includes("claim_live"), true);
    } finally {
      await ctx.close();
    }
  });

  it("does not invent a tx hash when createEscrow cannot be sent", async () => {
    const ctx = await boot(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1", CLAIM_API_SECRET: CLAIM_SECRET },
      {
        broadcaster: {
          async send() {
            throw Object.assign(new Error("execution reverted"), {
              status: 502,
              error: "broadcast_failed",
              reason: "execution reverted",
            });
          },
        },
      },
    );
    try {
      const missing = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        {
          action: "release",
          claimId: "0x" + "22".repeat(32),
          liveSubmit: true,
        },
        claimHeaders,
      );
      assert.equal(missing.status, 502);
      assert.equal(missing.json.txHash, null);
      assert.equal(missing.json.senderConstraint, "permissionless");

      const create = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        {
          action: "createEscrow",
          claimId: "0x" + "33".repeat(32),
          payee: PAYEE,
          payerBotId: "0x" + "44".repeat(32),
          payeeBotId: "0x" + "55".repeat(32),
          durationSeconds: "3600",
          amountWei: "1000",
          mode: "live",
        },
        claimHeaders,
      );
      assert.equal(create.status, 502);
      assert.equal(create.json.txHash, null);
      assert.equal(create.json.senderConstraint, "vault_operator_must_send");
      assert.match(create.json.senderNote, /Vault operator/);
      assert.equal(JSON.stringify(create.json).includes(SECRET), false);
    } finally {
      await ctx.close();
    }
  });

  it("pauses live claims with the kill switch and reports a missing signer", async () => {
    const sent = [];
    const paused = await boot(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1", KILL_SWITCH: "1" },
      {
        broadcaster: {
          async send(tx) {
            sent.push(tx);
            return { txHash: "0x" + "ab".repeat(32) };
          },
        },
      },
    );
    try {
      const claim = await request(paused.port, "POST", "/v1/claims", {
        action: "refund",
        claimId: "0x" + "66".repeat(32),
        live: true,
      });
      assert.equal(claim.status, 503);
      assert.equal(claim.json.error, "kill_switch");
      assert.equal(sent.length, 0);
    } finally {
      await paused.close();
    }

    const unsigned = await boot({ LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1", CLAIM_API_SECRET: CLAIM_SECRET });
    try {
      const claim = await request(
        unsigned.port,
        "POST",
        "/v1/claims",
        {
          action: "refund",
          claimId: "0x" + "66".repeat(32),
          live: true,
        },
        claimHeaders,
      );
      assert.equal(claim.status, 503);
      assert.equal(claim.json.error, "relayer_key_missing");
      assert.equal(claim.json.txHash, null);
    } finally {
      await unsigned.close();
    }
  });

  it("requires CLAIM_API_SECRET for live claims and leaves fixtures and quotes open", async () => {
    const sent = [];
    const txHash = "0x" + "ab".repeat(32);
    const escrowId = "0x" + "11".repeat(32);
    const broadcaster = {
      async send(tx) {
        sent.push(tx);
        return { txHash };
      },
    };
    const closed = await boot({ LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" }, { broadcaster });
    try {
      const live = await request(closed.port, "POST", "/v1/claims", {
        action: "release",
        claimId: escrowId,
        live: true,
      });
      assert.equal(live.status, 503);
      assert.equal(live.json.ok, false);
      assert.equal(live.json.error, "claim_api_secret_required");
      assert.equal(sent.length, 0);

      const fixture = await request(closed.port, "POST", "/v1/claims", {
        action: "release",
        claimId: escrowId,
      });
      assert.equal(fixture.status, 200);
      assert.equal(fixture.json.ok, true);
      assert.equal(fixture.json.mode, "fixture");
      assert.equal(fixture.json.txHash, null);
      assert.equal(sent.length, 0);

      const quote = await request(closed.port, "POST", "/v1/claims/quote", {
        payer: PAYER,
        payee: PAYEE,
        claimId: "quote-open",
      });
      assert.equal(quote.status, 200);
      assert.equal(quote.json.fixture, true);
      assert.equal(quote.json.dryRun, true);
      assert.equal(sent.length, 0);
    } finally {
      await closed.close();
    }

    const ctx = await boot(
      {
        LIVE_SUBMIT: "1",
        SPENCER_RUN_AUTH: "1",
        CLAIM_API_SECRET: CLAIM_SECRET,
        ADMIN_SECRET: "admin-test",
      },
      { broadcaster },
    );
    try {
      const missing = await request(ctx.port, "POST", "/v1/claims", {
        action: "release",
        claimId: escrowId,
        live: true,
      });
      assert.equal(missing.status, 401);
      assert.deepEqual(missing.json, { ok: false, error: "unauthorized" });

      const wrong = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        { action: "release", claimId: escrowId, live: true },
        { "x-claim-secret": "nope" },
      );
      assert.equal(wrong.status, 401);
      assert.deepEqual(wrong.json, { ok: false, error: "unauthorized" });

      const adminHeader = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        { action: "release", claimId: escrowId, mode: "broadcast" },
        { "x-admin-secret": "admin-test" },
      );
      assert.equal(adminHeader.status, 401);
      assert.equal(sent.length, 0);

      const bearerWrong = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        { action: "release", claimId: escrowId, live: true },
        { authorization: "Bearer nope" },
      );
      assert.equal(bearerWrong.status, 401);
      assert.equal(sent.length, 0);

      const ok = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        { action: "release", claimId: escrowId, live: true },
        claimHeaders,
      );
      assert.equal(ok.status, 200);
      assert.equal(ok.json.ok, true);
      assert.equal(ok.json.mode, "live");
      assert.equal(ok.json.txHash, txHash);
      assert.equal(sent.length, 1);
      assert.equal(JSON.stringify(ok.json).includes(CLAIM_SECRET), false);

      const bearer = await request(
        ctx.port,
        "POST",
        "/v1/claims",
        { action: "refund", claimId: "0x" + "77".repeat(32), liveSubmit: true },
        { authorization: `Bearer ${CLAIM_SECRET}` },
      );
      assert.equal(bearer.status, 200);
      assert.equal(bearer.json.txHash, txHash);
      assert.equal(sent.length, 2);

      const fixture = await request(ctx.port, "POST", "/v1/claims", {
        action: "release",
        claimId: escrowId,
      });
      assert.equal(fixture.status, 200);
      assert.equal(fixture.json.mode, "fixture");
      assert.equal(fixture.json.txHash, null);
      assert.equal(sent.length, 2);

      const quote = await request(ctx.port, "POST", "/v1/claims/quote", {
        payer: PAYER,
        payee: PAYEE,
        live: true,
      });
      assert.equal(quote.status, 409);
      assert.equal(quote.json.reason, "quote_does_not_broadcast");
      assert.equal(sent.length, 2);

      const pause = await request(ctx.port, "POST", "/v1/admin/pause", {}, claimHeaders);
      assert.equal(pause.status, 401);
      const paused = await request(ctx.port, "POST", "/v1/admin/pause", {}, { "x-admin-secret": "admin-test" });
      assert.equal(paused.status, 200);
      assert.equal(paused.json.killSwitch, true);

      const health = await request(ctx.port, "GET", "/health");
      assert.equal(JSON.stringify(health.json).includes(CLAIM_SECRET), false);
      const log = await readFile(ctx.logPath, "utf8");
      assert.equal(log.includes(CLAIM_SECRET), false);
    } finally {
      await ctx.close();
    }
  });

  it("advertises x-claim-secret on CORS preflight for the Pages origin", async () => {
    const ctx = await boot({
      CORS_ORIGINS: "https://agent-a-wallet-ux.pages.dev,http://localhost:5173",
    });
    try {
      const allowed = await request(ctx.port, "OPTIONS", "/v1/claims", undefined, {
        origin: "https://agent-a-wallet-ux.pages.dev",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-claim-secret",
      });
      assert.equal(allowed.status, 204);
      assert.equal(allowed.headers["access-control-allow-origin"], "https://agent-a-wallet-ux.pages.dev");
      assert.match(String(allowed.headers["access-control-allow-headers"]), /content-type/);
      assert.match(String(allowed.headers["access-control-allow-headers"]), /x-admin-secret/);
      assert.match(String(allowed.headers["access-control-allow-headers"]), /authorization/);
      assert.match(String(allowed.headers["access-control-allow-headers"]), /x-claim-secret/);

      const other = await request(ctx.port, "OPTIONS", "/v1/claims", undefined, {
        origin: "https://evil.example",
      });
      assert.equal(other.headers["access-control-allow-origin"], undefined);
      assert.match(String(other.headers["access-control-allow-headers"]), /x-claim-secret/);
    } finally {
      await ctx.close();
    }
  });
});

async function boot(env = {}, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "claim-relayer-"));
  const logPath = join(dir, "claims.jsonl");
  const config = loadConfig({
    CLAIM_LOG_PATH: logPath,
    QUOTE_TTL_MS: "60000",
    RELAYER_PRIVATE_KEY: SECRET,
    ...env,
  });
  const server = createClaimRelayer({
    config,
    killSwitch: createKillSwitch({ initial: config.killSwitchInitial }),
    nonceStore: createNonceStore(),
    claimLog: createClaimLog({ filePath: logPath }),
    broadcaster: extra.broadcaster ?? null,
    now: () => Date.parse("2026-09-25T19:00:00.000Z"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    port,
    logPath,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

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
          resolve({ status: res.statusCode, json, raw, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClaimRelayer } from "../app.mjs";
import { createClaimLog } from "../claimLog.mjs";
import { loadConfig } from "../config.mjs";
import { allowAllEligibility, recordingEnforcer } from "../reputation/hooks.mjs";
import { createRateLimiter } from "../reputation/rateLimit.mjs";
import { ARBITRATOR_LEDGER, USAGE_LEDGER } from "../reputation/reputationConfig.mjs";
import { createReputationRuntime } from "../reputation/runtime.mjs";
import { createKillSwitch } from "../killSwitch.mjs";
import { createNonceStore } from "../nonceStore.mjs";
import { BLOCK0, addr, businessLog, bytes32, dayTs } from "./reputationFixture.mjs";

const WALLET = addr(0x11);
const OTHER = addr(0x22);
const VOTER = addr(0x31);
const BANNED = /\b(reward|earn|earnings|apy|yield|allocation)\b/i;

function sampleLogs() {
  const bot = bytes32(1);
  const escrowId = bytes32(7);
  const disputeId = bytes32(8);
  const createdAt = dayTs(0, 0);
  return [
    businessLog({
      event: "OperatorSet",
      address: "0x1463D664fA467FBCDA4B05443434494f05e565bc",
      args: { botId: bot, account: WALLET },
      blockNumber: BLOCK0 + 1,
      timestamp: dayTs(1, 1),
    }),
    businessLog({
      event: "EscrowCreated",
      address: "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c",
      args: {
        escrowId,
        payer: WALLET,
        payee: OTHER,
        payerBotId: bot,
        payeeBotId: bytes32(2),
        amount: 1n,
        expiresAt: BigInt(createdAt + 10),
      },
      blockNumber: BLOCK0 + 2,
      timestamp: createdAt,
    }),
    businessLog({
      event: "EscrowDisputed",
      address: "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c",
      args: { escrowId, disputeId },
      blockNumber: BLOCK0 + 3,
      timestamp: dayTs(0, 2),
    }),
    businessLog({
      event: "VoteCast",
      address: "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb",
      args: { disputeId, voter: VOTER, support: true },
      blockNumber: BLOCK0 + 4,
      timestamp: dayTs(0, 3),
    }),
    businessLog({
      event: "DisputeResolved",
      address: "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb",
      args: { disputeId, upheld: true },
      blockNumber: BLOCK0 + 5,
      timestamp: dayTs(0, 4),
    }),
    businessLog({
      event: "EscrowReleased",
      address: "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c",
      args: { escrowId, amount: 1n },
      blockNumber: BLOCK0 + 6,
      timestamp: dayTs(0, 5),
    }),
  ];
}

async function boot(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "claim-relayer-rep-"));
  const config = loadConfig({ CLAIM_LOG_PATH: join(dir, "claims.jsonl"), RELAYER_PRIVATE_KEY: `0x${"ab".repeat(32)}` });
  const server = createClaimRelayer({
    config,
    killSwitch: createKillSwitch({ initial: false }),
    nonceStore: createNonceStore(),
    claimLog: createClaimLog({ filePath: join(dir, "claims.jsonl") }),
    broadcaster: null,
    ...extra,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null, raw });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function keysOf(value, acc = []) {
  if (!value || typeof value !== "object") return acc;
  for (const [key, child] of Object.entries(value)) {
    acc.push(key);
    keysOf(child, acc);
  }
  return acc;
}

describe("reputation read API", () => {
  it("returns both ledgers, draft caps, and disclaimer slots with no combined total", async () => {
    const reputation = createReputationRuntime({
      logs: sampleLogs(),
      safeBlock: BLOCK0 + 100,
      finalizedBlock: BLOCK0 + 100,
      hooks: { eligibility: allowAllEligibility(), enforcer: recordingEnforcer() },
    });
    const ctx = await boot({ reputation });
    try {
      const body = await request(ctx.port, "GET", `/v1/reputation/${WALLET}`);
      assert.equal(body.status, 200);
      assert.equal(body.json.chainId, 84532);
      assert.equal(body.json.testnet_only, true);
      assert.equal(body.json.caps_draft, true);
      assert.equal(body.json.caps_label, "DRAFT/GUESS");
      assert.match(body.json.disclaimer, /Testnet only/);
      assert.equal(body.json.disclaimer_links.as_is, "");
      assert.equal(body.json.disclaimer_links.bvt_securities_disclaimer, "");
      assert.equal(body.json.disclaimer_links.eligibility_notice, "");
      assert.equal(body.json.disclaimer_links.abuse_policy, "");
      assert.equal(body.json.ledgers[USAGE_LEDGER].final_points, 12);
      assert.equal(body.json.ledgers[ARBITRATOR_LEDGER].final_points, 0);
      assert.equal(keysOf(body.json).some((key) => /total|combined|sum/i.test(key)), false);
      assert.equal(BANNED.test(body.raw), false);
      const voter = await request(ctx.port, "GET", `/v1/reputation/${VOTER}`);
      assert.equal(voter.json.ledgers[ARBITRATOR_LEDGER].final_points, 5);
      assert.equal(voter.json.ledgers[USAGE_LEDGER].final_points, 0);
      assert.equal(voter.json.ledgers[USAGE_LEDGER].final_points + voter.json.ledgers[ARBITRATOR_LEDGER].final_points === 5, true);
      assert.equal(JSON.stringify(voter.json).includes('"5"') || voter.json.ledgers[ARBITRATOR_LEDGER].final_points === 5, true);
    } finally {
      await ctx.close();
    }
  });

  it("pages history and rejects bad input, other chains, and writes", async () => {
    const logs = [1, 2, 3].map((bot) =>
      businessLog({
        event: "OperatorSet",
        address: "0x1463D664fA467FBCDA4B05443434494f05e565bc",
        args: { botId: bytes32(bot), account: WALLET },
        blockNumber: BLOCK0 + bot,
        timestamp: dayTs(bot, 1),
      }),
    );
    const reputation = createReputationRuntime({
      logs,
      safeBlock: BLOCK0 + 100,
      finalizedBlock: BLOCK0 + 100,
      hooks: { eligibility: allowAllEligibility(), enforcer: recordingEnforcer() },
    });
    const ctx = await boot({ reputation, reputationRateLimit: createRateLimiter({ max: 20 }) });
    try {
      const page = await request(ctx.port, "GET", `/v1/reputation/${WALLET.toLowerCase()}/history?limit=2`);
      assert.equal(page.status, 200);
      assert.equal(page.json.entries.length, 2);
      assert.equal(page.json.chainId, 84532);
      assert.ok(page.json.next_cursor);
      assert.equal(BANNED.test(page.raw), false);
      const next = await request(
        ctx.port,
        "GET",
        `/v1/reputation/${WALLET}/history?limit=2&cursor=${encodeURIComponent(page.json.next_cursor)}`,
      );
      assert.equal(next.status, 200);
      assert.equal(next.json.entries.length, 1);
      assert.equal(next.json.next_cursor, null);
      const seen = new Set([...page.json.entries, ...next.json.entries].map((entry) => entry.entry_id));
      assert.equal(seen.size, 3);

      const bad = await request(ctx.port, "GET", "/v1/reputation/nope");
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, "invalid_address");
      const mainnet = await request(ctx.port, "GET", `/v1/reputation/${WALLET}?chainId=1`);
      assert.equal(mainnet.status, 400);
      assert.equal(mainnet.json.error, "mainnet_refused");
      const base = await request(ctx.port, "GET", `/v1/reputation/${WALLET}?chainId=8453`);
      assert.equal(base.status, 400);
      assert.equal(base.json.error, "mainnet_refused");
      const limit = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history?limit=0`);
      assert.equal(limit.status, 400);
      assert.equal(limit.json.error, "invalid_limit");
      const cursor = await request(ctx.port, "GET", `/v1/reputation/${WALLET}/history?cursor=not-a-cursor`);
      assert.equal(cursor.status, 400);
      assert.equal(cursor.json.error, "invalid_cursor");
      const ledger = await request(ctx.port, "GET", `/v1/reputation/${WALLET}?ledger=nope`);
      assert.equal(ledger.status, 400);
      assert.equal(ledger.json.error, "invalid_ledger");
      const post = await request(ctx.port, "POST", `/v1/reputation/${WALLET}`);
      assert.equal(post.status, 405);
      assert.equal(post.json.error, "method_not_allowed");
    } finally {
      await ctx.close();
    }
  });

  it("rate limits reads and leaves the default ledger uncredited", async () => {
    const limited = await boot({ reputationRateLimit: createRateLimiter({ max: 2 }) });
    try {
      const first = await request(limited.port, "GET", `/v1/reputation/${WALLET}`);
      const second = await request(limited.port, "GET", `/v1/reputation/${WALLET}`);
      const third = await request(limited.port, "GET", `/v1/reputation/${WALLET}`);
      assert.equal(first.status, 200);
      assert.equal(first.json.ledgers[USAGE_LEDGER].final_points, 0);
      assert.equal(first.json.ledgers[ARBITRATOR_LEDGER].provisional_points, 0);
      assert.equal(second.status, 200);
      assert.equal(third.status, 429);
      assert.equal(third.json.error, "rate_limited");
      assert.equal(BANNED.test(first.raw), false);
    } finally {
      await limited.close();
    }
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { topic0Table } from "../reputation/codec.mjs";
import { allowAllEligibility, createDefaultEnforcer, createDefaultHooks, recordingEnforcer } from "../reputation/hooks.mjs";
import { ARBITRATOR_LEDGER, USAGE_LEDGER, loadReputationConfig } from "../reputation/reputationConfig.mjs";
import { canonicalJson, contribution, replayLedger } from "../reputation/replay.mjs";
import {
  BLOCK0,
  DAY0,
  DENYLIST,
  ESCROW,
  FLOOR,
  PANEL,
  VAULT,
  addr,
  businessLog,
  bytes32,
  dayTs,
} from "./reputationFixture.mjs";

const PAYER = addr(0x11);
const PAYEE = addr(0x22);
const OPERATOR = addr(0xaa);
const VOTER_A = addr(0x31);
const VOTER_B = addr(0x32);
const VOTER_C = addr(0x33);
const CHALLENGER = addr(0x41);

const loaded = loadReputationConfig();
const scoring = () => ({ eligibility: allowAllEligibility(), enforcer: recordingEnforcer() });

function play(logs, extra = {}) {
  return replayLedger({
    chainId: 84532,
    logs,
    safeBlock: extra.safeBlock ?? BLOCK0 + 100_000,
    finalizedBlock: extra.finalizedBlock ?? BLOCK0 + 100_000,
    versions: extra.versions || loaded.versions,
    hooks: extra.hooks || scoring(),
    adjustments: extra.adjustments,
  });
}

function ofCode(result, code) {
  return result.entries.filter((entry) => entry.outcome_code === code);
}

function walletPoints(result, wallet, ledger = USAGE_LEDGER) {
  return result.entries
    .filter((entry) => entry.ledger === ledger && entry.wallet.toLowerCase() === wallet.toLowerCase())
    .reduce((sum, entry) => sum + contribution(entry), 0);
}

function operatorSet(bot, account, block, day = 0, offset = 10) {
  return businessLog({
    event: "OperatorSet",
    address: VAULT,
    args: { botId: bytes32(bot), account },
    blockNumber: block,
    timestamp: dayTs(day, offset),
  });
}

function created(escrowId, { payer = PAYER, payee = PAYEE, payerBot = 1, payeeBot = 2, amount = FLOOR, duration = 7200, block, day = 0, offset = 0 } = {}) {
  const timestamp = dayTs(day, offset);
  return businessLog({
    event: "EscrowCreated",
    address: ESCROW,
    args: {
      escrowId: bytes32(escrowId),
      payer,
      payee,
      payerBotId: bytes32(payerBot),
      payeeBotId: bytes32(payeeBot),
      amount,
      expiresAt: BigInt(timestamp + duration),
    },
    blockNumber: block,
    timestamp,
  });
}

function released(escrowId, block, timestamp, amount = FLOOR) {
  return businessLog({
    event: "EscrowReleased",
    address: ESCROW,
    args: { escrowId: bytes32(escrowId), amount },
    blockNumber: block,
    timestamp,
  });
}

function refunded(escrowId, block, timestamp, amount = FLOOR) {
  return businessLog({
    event: "EscrowRefunded",
    address: ESCROW,
    args: { escrowId: bytes32(escrowId), amount },
    blockNumber: block,
    timestamp,
  });
}

function disputed(escrowId, disputeId, block, timestamp) {
  return businessLog({
    event: "EscrowDisputed",
    address: ESCROW,
    args: { escrowId: bytes32(escrowId), disputeId: bytes32(disputeId) },
    blockNumber: block,
    timestamp,
  });
}

function opened(disputeId, subject, challenger, block, timestamp) {
  return businessLog({
    event: "DisputeOpened",
    address: PANEL,
    args: { disputeId: bytes32(disputeId), subjectHash: bytes32(subject), challenger },
    blockNumber: block,
    timestamp,
  });
}

function vote(disputeId, voter, support, block, timestamp, logIndex = 0, tx) {
  return businessLog({
    event: "VoteCast",
    address: PANEL,
    args: { disputeId: bytes32(disputeId), voter, support },
    blockNumber: block,
    logIndex,
    timestamp,
    tx,
  });
}

function resolved(disputeId, upheld, block, timestamp, logIndex = 0, tx) {
  return businessLog({
    event: "DisputeResolved",
    address: PANEL,
    args: { disputeId: bytes32(disputeId), upheld },
    blockNumber: block,
    logIndex,
    timestamp,
    tx,
  });
}

describe("reputation config", () => {
  it("loads section 7 defaults as DRAFT/GUESS and refuses to hardcode them into the scorer", () => {
    const raw = JSON.parse(readFileSync(new URL("../../config/reputation/sepolia.json", import.meta.url), "utf8"));
    assert.equal(raw.caps._label, "DRAFT/GUESS");
    assert.equal(raw.points._guess, true);
    assert.equal(raw.caps.usage_points_per_wallet_per_day.value, 20);
    assert.equal(raw.caps.usage_points_per_bot_per_day.value, 20);
    assert.equal(raw.caps.escrows_per_wallet_per_day.value, 5);
    assert.equal(raw.caps.o3_per_wallet_per_day.value, 1);
    assert.equal(raw.caps.o4_per_wallet_per_day.value, 1);
    assert.equal(raw.caps.pair_per_day.value, 2);
    assert.equal(raw.caps.pair_lifetime.value, 10);
    assert.equal(raw.caps.usage_points_per_wallet_per_season.value, 500);
    assert.equal(raw.caps.arbitrator_points_per_day.value, 30);
    assert.equal(raw.floors.min_amount_wei.value, "100000000000000");
    assert.equal(raw.floors.o2_min_create_to_release_seconds.value, 300);
    assert.equal(raw.floors.o3_min_set_duration_seconds.value, 3600);
    assert.equal(raw.day_implementation.value, "utc_day_by_block_timestamp");
    assert.equal(loaded.latest.contracts.vault.start_block, 47294164);
    assert.equal(loaded.latest.contracts.escrow.start_block, 47299930);
    assert.equal(loaded.latest.contracts.dispute_panel.start_block, 47253020);
    const book = JSON.parse(readFileSync(new URL("../../deployments/base-sepolia.json", import.meta.url), "utf8"));
    assert.equal(loaded.latest.contracts.vault.address, book.Vault.address);
    assert.equal(loaded.latest.contracts.escrow.address, book.BotAttestationEscrow.address);
    assert.equal(loaded.latest.contracts.dispute_panel.address, book.DisputePanel.address);
    const source = readFileSync(new URL("../reputation/replay.mjs", import.meta.url), "utf8");
    assert.equal(source.includes("usage_points_per_wallet_per_day: 20"), false);
    assert.equal(source.includes("100000000000000"), false);
  });

  it("matches the PR #28 topic0 table for scored events", () => {
    const expected = {
      OperatorSet: "0x9efccfdeeb35d36624f8546b14ab72aa768151985ee15f2f7dfce288348baaa3",
      EscrowCreated: "0x9d605e83d5554e0f88f697fe6184e9d0616163c141daf3ba689299e334a285c1",
      EscrowReleased: "0x9410e7c5b50451e4b5bd5ce113fd48abebd7070eb9d080df08b115b7cdc41650",
      EscrowRefunded: "0x21cabc2fff910e5afd1e2bcb22ff2b165a41ab0afbaf364f07aaf2f7787fb908",
      EscrowDisputed: "0xcd4243485a48c9b2bc0e6ac4133f40bcac2bc94a0807c72c2dc2d60e023d2995",
      DisputeOpened: "0xff7eb321cb9f047b29ab55a1eaab2dbd40f73e1ec2b34cf847246a5ea1b0b535",
      VoteCast: "0x8b40665146691327ee30f5bf56e9b2d6f445d2830d3b09b56385cd30f630ecfb",
      DisputeResolved: "0x6309d9f2499864a4f9d4ddb22f2b493afde8c215a1cd2e178647596cffe2efa4",
    };
    const table = Object.fromEntries(topic0Table().map((row) => [row.name, row.topic0]));
    for (const [name, topic] of Object.entries(expected)) assert.equal(table[name], topic);
  });
});

describe("outcome rules", () => {
  it("credits O1 once on the first OperatorSet and ignores rotation", () => {
    const result = play([
      operatorSet(1, OPERATOR, BLOCK0 + 2, 0, 20),
      operatorSet(1, PAYER, BLOCK0 + 3, 0, 30),
    ]);
    const rows = ofCode(result, "O1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].points, 10);
    assert.equal(rows[0].wallet, OPERATOR);
    assert.equal(rows[0].bot_id, bytes32(1));
    assert.equal(rows[0].entry_id, `O1:${bytes32(1)}`);
    assert.equal(rows[0].rule_version, "design-v2");
    assert.equal(rows[0].config_version, "sepolia-draft-0");
    assert.equal(rows[0].chain_id, 84532);
    assert.equal(walletPoints(result, PAYER), 0);
  });

  it("credits O2 to payer and payee from EscrowCreated when release is undisputed, long enough, and above the floor", () => {
    const create = created(10, { block: BLOCK0 + 10, day: 1, offset: 0 });
    const release = released(10, BLOCK0 + 11, dayTs(1, 300));
    const result = play([release, create]);
    const rows = ofCode(result, "O2");
    assert.equal(rows.length, 2);
    assert.equal(walletPoints(result, PAYER), 5);
    assert.equal(walletPoints(result, PAYEE), 5);
    assert.equal(rows[0].semantic_key, rows[1].semantic_key);
    assert.equal(rows[0].semantic_key, `O2:${bytes32(10)}`);
    assert.equal(new Set(rows.map((row) => row.entry_id)).size, 2);
    assert.equal(rows.every((row) => row.ledger === USAGE_LEDGER), true);
  });

  it("withholds O2 below the amount floor or under 5 minutes", () => {
    const low = play([
      created(11, { block: BLOCK0 + 1, amount: FLOOR - 1n, day: 2 }),
      released(11, BLOCK0 + 2, dayTs(2, 600), FLOOR - 1n),
    ]);
    assert.equal(ofCode(low, "O2").length, 0);
    const fast = play([
      created(12, { block: BLOCK0 + 1, day: 2 }),
      released(12, BLOCK0 + 2, dayTs(2, 299)),
    ]);
    assert.equal(ofCode(fast, "O2").length, 0);
    const exact = play([
      created(13, { block: BLOCK0 + 1, day: 2 }),
      released(13, BLOCK0 + 2, dayTs(2, 300)),
    ]);
    assert.equal(ofCode(exact, "O2").length, 2);
  });

  it("credits O3 only to the payer, and only for a long enough undisputed refund above the floor", () => {
    const ok = play([
      created(20, { block: BLOCK0 + 1, day: 3, duration: 3600 }),
      refunded(20, BLOCK0 + 2, dayTs(3, 4000)),
    ]);
    assert.equal(ofCode(ok, "O3").length, 1);
    assert.equal(walletPoints(ok, PAYER), 1);
    assert.equal(walletPoints(ok, PAYEE), 0);
    const short = play([
      created(21, { block: BLOCK0 + 1, day: 3, duration: 3599 }),
      refunded(21, BLOCK0 + 2, dayTs(3, 4000)),
    ]);
    assert.equal(ofCode(short, "O3").length, 0);
    const dust = play([
      created(22, { block: BLOCK0 + 1, day: 3, duration: 3600, amount: FLOOR - 1n }),
      refunded(22, BLOCK0 + 2, dayTs(3, 4000), FLOOR - 1n),
    ]);
    assert.equal(ofCode(dust, "O3").length, 0);
  });

  it("excludes an escrow from O2 and O3 once EscrowDisputed exists, in either order", () => {
    const releaseThenDispute = play([
      created(30, { block: BLOCK0 + 1, day: 4 }),
      released(30, BLOCK0 + 2, dayTs(4, 300)),
      disputed(30, 30, BLOCK0 + 3, dayTs(4, 400)),
    ]);
    assert.equal(ofCode(releaseThenDispute, "O2").length, 0);
    assert.equal(ofCode(releaseThenDispute, "O4").length, 0);
    const disputeThenRefund = play([
      created(31, { block: BLOCK0 + 1, day: 4, duration: 3600 }),
      disputed(31, 31, BLOCK0 + 2, dayTs(4, 10)),
      refunded(31, BLOCK0 + 3, dayTs(4, 4000)),
    ]);
    assert.equal(ofCode(disputeThenRefund, "O3").length, 0);
    assert.equal(ofCode(disputeThenRefund, "O4").length, 0);
    assert.equal(walletPoints(disputeThenRefund, PAYER), 0);
  });

  it("credits O4 in every order once disputed, resolved, and terminal", () => {
    const names = ["disputed", "resolved", "released"];
    const orders = permutations(names);
    assert.equal(orders.length, 6);
    for (const order of orders) {
      const logs = [created(40, { block: BLOCK0 + 1, day: 5, amount: 1n, duration: 1 })];
      order.forEach((name, index) => {
        const block = BLOCK0 + 2 + index;
        const timestamp = dayTs(5, 20 + index);
        if (name === "disputed") logs.push(disputed(40, 40, block, timestamp));
        if (name === "resolved") logs.push(resolved(40, true, block, timestamp));
        if (name === "released") logs.push(released(40, block, timestamp, 1n));
      });
      const result = play(logs);
      const rows = ofCode(result, "O4");
      assert.equal(rows.length, 2, order.join(","));
      assert.equal(walletPoints(result, PAYER), 2, order.join(","));
      assert.equal(walletPoints(result, PAYEE), 2, order.join(","));
      assert.equal(ofCode(result, "O2").length, 0);
      assert.equal(rows[0].semantic_key, `O4:${bytes32(40)}`);
    }
    const resolvedLast = play([
      resolved(41, false, BLOCK0 + 1, dayTs(5, 1)),
      refunded(41, BLOCK0 + 2, dayTs(5, 2), 1n),
      created(41, { block: BLOCK0 + 3, day: 5, amount: 1n, duration: 1 }),
      disputed(41, 41, BLOCK0 + 4, dayTs(5, 4)),
    ]);
    assert.equal(walletPoints(resolvedLast, PAYER), 2);
    assert.equal(walletPoints(resolvedLast, PAYEE), 2);
  });

  it("records O5 for a non-escrow subject and for an unlinked terminal escrow, and not while the escrow is still open", () => {
    const standalone = play([opened(50, 900, CHALLENGER, BLOCK0 + 1, dayTs(6, 1))]);
    assert.equal(ofCode(standalone, "O5").length, 1);
    assert.equal(ofCode(standalone, "O5")[0].points, 0);
    assert.equal(ofCode(standalone, "O5")[0].wallet, CHALLENGER);
    const openEscrow = play([
      created(51, { block: BLOCK0 + 1, day: 6 }),
      opened(51, 51, CHALLENGER, BLOCK0 + 2, dayTs(6, 2)),
    ]);
    assert.equal(ofCode(openEscrow, "O5").length, 0);
    const releasedUnlinked = play([
      created(52, { block: BLOCK0 + 1, day: 6 }),
      released(52, BLOCK0 + 2, dayTs(6, 300)),
      opened(53, 52, CHALLENGER, BLOCK0 + 3, dayTs(6, 400)),
    ]);
    assert.equal(ofCode(releasedUnlinked, "O5").length, 1);
    assert.equal(ofCode(releasedUnlinked, "O2").length, 2);
    const linked = play([
      created(54, { block: BLOCK0 + 1, day: 6, amount: 1n, duration: 1 }),
      opened(54, 54, CHALLENGER, BLOCK0 + 2, dayTs(6, 2)),
      disputed(54, 54, BLOCK0 + 3, dayTs(6, 3)),
      resolved(54, true, BLOCK0 + 4, dayTs(6, 4)),
      released(54, BLOCK0 + 5, dayTs(6, 5), 1n),
    ]);
    assert.equal(ofCode(linked, "O5").length, 0);
    assert.equal(ofCode(linked, "O4").length, 2);
  });

  it("credits A1 per vote and A2 only when support matches upheld, after the link in any order", () => {
    const early = [
      vote(60, VOTER_A, true, BLOCK0 + 1, dayTs(7, 1)),
      vote(60, VOTER_B, true, BLOCK0 + 2, dayTs(7, 2)),
      resolved(60, true, BLOCK0 + 3, dayTs(7, 3), 0, bytes32(0x777)),
      vote(60, VOTER_C, false, BLOCK0 + 3, dayTs(7, 3), 1, bytes32(0x777)),
    ];
    const linkLast = play([
      ...early,
      created(60, { block: BLOCK0 + 4, day: 7, amount: 1n, duration: 1 }),
      disputed(60, 60, BLOCK0 + 5, dayTs(7, 5)),
      released(60, BLOCK0 + 6, dayTs(7, 6), 1n),
    ]);
    assert.equal(ofCode(linkLast, "A1").length, 3);
    assert.equal(ofCode(linkLast, "A2").length, 2);
    assert.equal(walletPoints(linkLast, VOTER_A, ARBITRATOR_LEDGER), 5);
    assert.equal(walletPoints(linkLast, VOTER_C, ARBITRATOR_LEDGER), 3);
    assert.equal(walletPoints(linkLast, PAYER, USAGE_LEDGER), 2);
    assert.equal(walletPoints(linkLast, VOTER_A, USAGE_LEDGER), 0);
    const linkFirst = play([
      created(61, { block: BLOCK0 + 1, day: 7, amount: 1n, duration: 1 }),
      disputed(61, 61, BLOCK0 + 2, dayTs(7, 2)),
      vote(61, VOTER_A, false, BLOCK0 + 3, dayTs(7, 3)),
      vote(61, VOTER_B, false, BLOCK0 + 4, dayTs(7, 4)),
      resolved(61, false, BLOCK0 + 5, dayTs(7, 5), 0, bytes32(0x778)),
      vote(61, VOTER_C, true, BLOCK0 + 5, dayTs(7, 5), 1, bytes32(0x778)),
      refunded(61, BLOCK0 + 6, dayTs(7, 6), 1n),
    ]);
    assert.equal(ofCode(linkFirst, "A1").length, 3);
    assert.equal(walletPoints(linkFirst, VOTER_A, ARBITRATOR_LEDGER), 5);
    assert.equal(walletPoints(linkFirst, VOTER_C, ARBITRATOR_LEDGER), 3);
    const unlinked = play([
      vote(62, VOTER_A, true, BLOCK0 + 1, dayTs(7, 1)),
      resolved(62, true, BLOCK0 + 2, dayTs(7, 2)),
    ]);
    assert.equal(ofCode(unlinked, "A1").length, 0);
  });
});

describe("caps", () => {
  it("caps usage points at 20 per wallet per UTC day", () => {
    const logs = [1, 2, 3].map((bot) => operatorSet(bot, OPERATOR, BLOCK0 + bot, 0, bot));
    const result = play(logs);
    const rows = ofCode(result, "O1");
    assert.equal(rows.filter((row) => row.points === 10).length, 2);
    assert.equal(rows.filter((row) => row.capped && row.cap_name === "usage_points_per_wallet_per_day").length, 1);
    assert.equal(walletPoints(result, OPERATOR), 20);
  });

  it("caps counted escrows at 5 per wallet per day for O2 and O3", () => {
    const versions = bump(loaded.versions, {
      usage_points_per_wallet_per_day: 1000,
      usage_points_per_bot_per_day: 1000,
      pair_per_day: 100,
      pair_lifetime: 100,
    });
    const logs = [];
    for (let i = 0; i < 6; i += 1) {
      const payee = addr(0x30 + i);
      logs.push(
        created(200 + i, {
          payee,
          payerBot: 200 + i,
          payeeBot: 300 + i,
          block: BLOCK0 + 10 + i * 2,
          day: 8,
          offset: i,
        }),
      );
      logs.push(released(200 + i, BLOCK0 + 11 + i * 2, dayTs(8, 300 + i)));
    }
    const result = play(logs, { versions });
    assert.equal(ofCode(result, "O2").filter((row) => row.wallet === PAYER && row.points === 5).length, 5);
    assert.equal(
      ofCode(result, "O2").some((row) => row.wallet === PAYER && row.cap_name === "escrows_per_wallet_per_day"),
      true,
    );
    const o3logs = [
      created(210, { block: BLOCK0 + 1, day: 9, duration: 3600 }),
      released(210, BLOCK0 + 2, dayTs(9, 300)),
      created(211, { block: BLOCK0 + 3, day: 9, duration: 3600, payee: addr(0x45) }),
      refunded(211, BLOCK0 + 4, dayTs(9, 4000)),
    ];
    const tight = bump(loaded.versions, {
      usage_points_per_wallet_per_day: 1000,
      escrows_per_wallet_per_day: 1,
      pair_per_day: 10,
      pair_lifetime: 10,
    });
    const mixed = play(o3logs, { versions: tight });
    assert.equal(ofCode(mixed, "O3").find((row) => row.wallet === PAYER).cap_name, "escrows_per_wallet_per_day");
  });

  it("caps the same payer/payee pair at 2 per day and 10 lifetime", () => {
    const dayLogs = [];
    for (let i = 0; i < 3; i += 1) {
      dayLogs.push(created(300 + i, { block: BLOCK0 + i * 2, day: 10, offset: i, payerBot: 10 + i, payeeBot: 20 + i }));
      dayLogs.push(released(300 + i, BLOCK0 + 1 + i * 2, dayTs(10, 300 + i)));
    }
    const day = play(dayLogs);
    assert.equal(ofCode(day, "O2").filter((row) => row.points === 5 && row.wallet === PAYER).length, 2);
    assert.equal(ofCode(day, "O2").some((row) => row.cap_name === "pair_per_day"), true);
    const life = [];
    for (let i = 0; i < 11; i += 1) {
      life.push(created(320 + i, { block: BLOCK0 + i * 2, day: 11 + i, offset: 0, payerBot: 30 + i, payeeBot: 50 + i }));
      life.push(released(320 + i, BLOCK0 + 1 + i * 2, dayTs(11 + i, 300)));
    }
    const lifeResult = play(life);
    assert.equal(ofCode(lifeResult, "O2").filter((row) => row.wallet === PAYER && row.points === 5).length, 10);
    assert.equal(ofCode(lifeResult, "O2").some((row) => row.cap_name === "pair_lifetime"), true);
  });

  it("caps O3 and O4 at one per wallet per day and bots at 20 points per day", () => {
    const o3 = play([
      created(400, { block: BLOCK0 + 1, day: 30, duration: 3600, payee: addr(0x51) }),
      refunded(400, BLOCK0 + 2, dayTs(30, 4000)),
      created(401, { block: BLOCK0 + 3, day: 30, duration: 3600, payee: addr(0x52), payerBot: 3, payeeBot: 4 }),
      refunded(401, BLOCK0 + 4, dayTs(30, 5000)),
    ]);
    assert.equal(ofCode(o3, "O3").filter((row) => row.points === 1).length, 1);
    assert.equal(ofCode(o3, "O3").some((row) => row.cap_name === "o3_per_wallet_per_day"), true);
    const o4logs = [];
    for (let i = 0; i < 2; i += 1) {
      o4logs.push(created(410 + i, { block: BLOCK0 + 10 + i * 5, day: 31, offset: i, amount: 1n, duration: 1, payee: addr(0x60 + i), payerBot: 70 + i, payeeBot: 80 + i }));
      o4logs.push(disputed(410 + i, 410 + i, BLOCK0 + 11 + i * 5, dayTs(31, 10 + i)));
      o4logs.push(resolved(410 + i, true, BLOCK0 + 12 + i * 5, dayTs(31, 11 + i)));
      o4logs.push(released(410 + i, BLOCK0 + 13 + i * 5, dayTs(31, 12 + i), 1n));
    }
    const o4 = play(o4logs);
    assert.equal(ofCode(o4, "O4").filter((row) => row.wallet === PAYER && row.points === 2).length, 1);
    assert.equal(ofCode(o4, "O4").some((row) => row.wallet === PAYER && row.cap_name === "o4_per_wallet_per_day"), true);
    const versions = bump(loaded.versions, { usage_points_per_wallet_per_day: 1000, pair_per_day: 20, pair_lifetime: 20 });
    const botLogs = [];
    for (let i = 0; i < 5; i += 1) {
      botLogs.push(created(430 + i, { block: BLOCK0 + i * 2, day: 32, offset: i, payee: addr(0x70 + i), payerBot: 1, payeeBot: 90 + i }));
      botLogs.push(released(430 + i, BLOCK0 + 1 + i * 2, dayTs(32, 300 + i)));
    }
    const bots = play(botLogs, { versions });
    const payerRows = ofCode(bots, "O2").filter((row) => row.wallet === PAYER);
    assert.equal(payerRows.filter((row) => row.points === 5).length, 4);
    assert.equal(payerRows.some((row) => row.cap_name === "usage_points_per_bot_per_day"), true);
  });

  it("caps a wallet at 500 usage points in the open draft season", () => {
    const logs = [];
    for (let i = 0; i < 51; i += 1) {
      const day = Math.floor(i / 2);
      logs.push(operatorSet(1000 + i, OPERATOR, BLOCK0 + i, day, (i % 2) + 1));
    }
    const result = play(logs);
    assert.equal(walletPoints(result, OPERATOR), 500);
    const last = ofCode(result, "O1").find((row) => row.bot_id === bytes32(1050));
    assert.equal(last.points, 0);
    assert.equal(last.cap_name, "usage_points_per_wallet_per_season");
  });

  it("caps arbitrator points at 30 per UTC day", () => {
    const logs = [];
    for (let dispute = 0; dispute < 7; dispute += 1) {
      const id = 500 + dispute;
      const base = BLOCK0 + dispute * 20;
      logs.push(created(id, { block: base, day: 40, offset: dispute, amount: 1n, duration: 1, payee: addr(0x80 + dispute) }));
      logs.push(disputed(id, id, base + 1, dayTs(40, 100 + dispute)));
      logs.push(resolved(id, true, base + 2, dayTs(40, 200 + dispute)));
      logs.push(vote(id, VOTER_A, true, base + 3, dayTs(40, 300 + dispute)));
      logs.push(vote(id, addr(0x90 + dispute), true, base + 4, dayTs(40, 400 + dispute)));
      logs.push(vote(id, addr(0xb0 + dispute), true, base + 5, dayTs(40, 500 + dispute)));
      logs.push(released(id, base + 6, dayTs(40, 600 + dispute), 1n));
    }
    const result = play(logs);
    assert.equal(walletPoints(result, VOTER_A, ARBITRATOR_LEDGER), 30);
    const capped = ofCode(result, "A1").filter((row) => row.wallet === VOTER_A && row.capped);
    assert.equal(capped.length, 1);
    assert.equal(capped[0].cap_name, "arbitrator_points_per_day");
  });

  it("does not give a cancelled entry its cap headroom back", () => {
    const first = operatorSet(1, OPERATOR, BLOCK0 + 1, 50, 1);
    const second = operatorSet(2, OPERATOR, BLOCK0 + 2, 50, 2);
    const third = operatorSet(3, OPERATOR, BLOCK0 + 3, 50, 3);
    const preview = play([first, second]);
    const target = ofCode(preview, "O1").find((row) => row.bot_id === bytes32(1));
    const result = play([first, second, third], {
      adjustments: [
        {
          adjustment_id: "adj-cap",
          ledger: USAGE_LEDGER,
          wallet: OPERATOR,
          points: 0,
          effective_block: BLOCK0 + 10,
          block_timestamp: dayTs(50, 20),
          cancel_reason: "manual cancel",
          cancelled_by: "enforcer",
          cancels_entry_id: target.entry_id,
        },
      ],
    });
    assert.equal(ofCode(result, "O1").find((row) => row.bot_id === bytes32(1)).status, "cancelled");
    assert.equal(ofCode(result, "O1").find((row) => row.bot_id === bytes32(3)).cap_name, "usage_points_per_wallet_per_day");
    assert.equal(walletPoints(result, OPERATOR), 10);
  });
});

describe("dedup, chain, finality, hooks, and separation", () => {
  it("counts one escrow once when the same release is re-included at a new log index", () => {
    const tx = bytes32(0xabc);
    const create = created(600, { block: BLOCK0 + 1, day: 60 });
    const orphan = released(600, BLOCK0 + 2, dayTs(60, 300));
    orphan.transactionHash = tx;
    orphan.blockHash = bytes32(0x111);
    orphan.logIndex = 1;
    orphan.removed = true;
    const canonical = released(600, BLOCK0 + 3, dayTs(60, 300));
    canonical.transactionHash = tx;
    canonical.blockHash = bytes32(0x222);
    canonical.logIndex = 7;
    const result = play([create, orphan, canonical]);
    const rows = ofCode(result, "O2");
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => row.block_hash === bytes32(0x222)), true);
    assert.equal(walletPoints(result, PAYER) + walletPoints(result, PAYEE), 10);
    const again = released(600, BLOCK0 + 4, dayTs(60, 300));
    again.transactionHash = tx;
    again.blockHash = bytes32(0x333);
    again.logIndex = 2;
    const replaced = play([create, canonical, again]);
    assert.equal(ofCode(replaced, "O2").length, 2);
    assert.equal(ofCode(replaced, "O2").every((row) => row.block_hash === bytes32(0x333)), true);
  });

  it("refuses chain ids other than 84532, including 1 and 8453", () => {
    assert.throws(() => replayLedger({ chainId: 1, logs: [] }), (err) => err.error === "mainnet_refused");
    assert.throws(() => replayLedger({ chainId: 8453, logs: [] }), (err) => err.error === "mainnet_refused");
    assert.throws(() => replayLedger({ chainId: 11155111, logs: [] }), (err) => err.error === "wrong_chain");
    const log = operatorSet(1, OPERATOR, BLOCK0 + 1);
    log.chainId = 1;
    assert.throws(() => play([log]), (err) => err.error === "mainnet_refused");
  });

  it("is provisional at the safe head and final only once every source log is finalized", () => {
    const logs = [operatorSet(1, OPERATOR, BLOCK0 + 10, 61, 1)];
    const provisional = play(logs, { safeBlock: BLOCK0 + 10, finalizedBlock: BLOCK0 + 9 });
    assert.equal(ofCode(provisional, "O1")[0].status, "provisional");
    const hidden = play(logs, { safeBlock: BLOCK0 + 9, finalizedBlock: BLOCK0 + 9 });
    assert.equal(ofCode(hidden, "O1").length, 0);
    const create = created(610, { block: BLOCK0 + 1, day: 61 });
    const release = released(610, BLOCK0 + 20, dayTs(61, 300));
    const mixed = play([create, release], { safeBlock: BLOCK0 + 20, finalizedBlock: BLOCK0 + 1 });
    assert.equal(ofCode(mixed, "O2")[0].status, "provisional");
    const final = play([create, release], { safeBlock: BLOCK0 + 20, finalizedBlock: BLOCK0 + 20 });
    assert.equal(ofCode(final, "O2").every((row) => row.status === "final"), true);
  });

  it("rebuilds a byte-identical ledger from the same logs in any order", () => {
    const logs = [
      operatorSet(1, OPERATOR, BLOCK0 + 1, 62, 1),
      created(620, { block: BLOCK0 + 2, day: 62 }),
      released(620, BLOCK0 + 3, dayTs(62, 300)),
      opened(621, 999, CHALLENGER, BLOCK0 + 4, dayTs(62, 10)),
    ];
    const forward = canonicalJson(play(logs));
    const backward = canonicalJson(play([...logs].reverse()));
    const shuffled = canonicalJson(play([logs[2], logs[0], logs[3], logs[1]]));
    assert.equal(forward, backward);
    assert.equal(forward, shuffled);
  });

  it("keeps the usage and arbitrator ledgers apart", () => {
    const result = play([
      operatorSet(1, OPERATOR, BLOCK0 + 1, 63, 1),
      created(630, { block: BLOCK0 + 2, day: 63, amount: 1n, duration: 1 }),
      disputed(630, 630, BLOCK0 + 3, dayTs(63, 2)),
      vote(630, VOTER_A, true, BLOCK0 + 4, dayTs(63, 3)),
      resolved(630, true, BLOCK0 + 5, dayTs(63, 4), 0, bytes32(0x779)),
      vote(630, VOTER_A, true, BLOCK0 + 5, dayTs(63, 4), 1, bytes32(0x779)),
      released(630, BLOCK0 + 6, dayTs(63, 5), 1n),
    ]);
    assert.equal(walletPoints(result, OPERATOR, USAGE_LEDGER), 10);
    assert.equal(walletPoints(result, VOTER_A, ARBITRATOR_LEDGER), 5);
    assert.equal(walletPoints(result, VOTER_A, USAGE_LEDGER), 0);
    assert.equal(walletPoints(result, PAYER, USAGE_LEDGER), 2);
    assert.equal(result.usage_ledger, USAGE_LEDGER);
    assert.equal(result.arbitrator_ledger, ARBITRATOR_LEDGER);
    assert.equal("total" in result, false);
    assert.equal(result.entries.some((entry) => entry.ledger !== USAGE_LEDGER && entry.ledger !== ARBITRATOR_LEDGER), false);
  });

  it("marks entries not eligible by default and withholds usage after three standalone disputes in seven UTC days", () => {
    const log = operatorSet(1, OPERATOR, BLOCK0 + 1, 64, 1);
    const closed = play([log], { hooks: createDefaultHooks() });
    assert.equal(ofCode(closed, "O1")[0].eligible, false);
    assert.equal(ofCode(closed, "O1")[0].eligibility_reason, "ofac_unconfigured");
    assert.equal(ofCode(closed, "O1")[0].points, 0);
    assert.equal(ofCode(closed, "O1")[0].nominal_points, 10);
    assert.equal(walletPoints(closed, OPERATOR), 0);
    const burst = [0, 1, 2].map((i) => opened(700 + i, 800 + i, CHALLENGER, BLOCK0 + i, dayTs(65, i)));
    const later = operatorSet(9, CHALLENGER, BLOCK0 + 10, 65, 50);
    const flagged = play([...burst, later], {
      hooks: { eligibility: allowAllEligibility(), enforcer: createDefaultEnforcer() },
    });
    assert.equal(flagged.enforcer_flags.some((flag) => flag.kind === "O5_REPEAT"), true);
    const onboard = ofCode(flagged, "O1")[0];
    assert.equal(onboard.enforcer_withheld, true);
    assert.equal(onboard.points, 0);
    const early = operatorSet(9, CHALLENGER, BLOCK0 + 1, 66, 1);
    const disputes = [0, 1, 2].map((i) => opened(710 + i, 810 + i, CHALLENGER, BLOCK0 + 5 + i, dayTs(66, 10 + i)));
    const before = play([early, ...disputes], {
      hooks: { eligibility: allowAllEligibility(), enforcer: createDefaultEnforcer() },
    });
    assert.equal(ofCode(before, "O1")[0].points, 10);
    const spaced = play(
      [
        opened(720, 820, CHALLENGER, BLOCK0 + 1, dayTs(0, 1)),
        opened(721, 821, CHALLENGER, BLOCK0 + 2, dayTs(0, 2)),
        opened(722, 822, CHALLENGER, BLOCK0 + 3, dayTs(7, 1)),
      ],
      { hooks: { eligibility: allowAllEligibility(), enforcer: createDefaultEnforcer() } },
    );
    assert.equal(spaced.enforcer_flags.some((flag) => flag.kind === "O5_REPEAT"), false);
  });

  it("applies a versioned adjustment file during replay and keeps older blocks on the config active then", () => {
    const log = operatorSet(1, OPERATOR, BLOCK0 + 1, 70, 1);
    const preview = play([log]);
    const target = ofCode(preview, "O1")[0];
    const cancelled = play([log], {
      adjustments: [
        {
          adjustment_id: "adj-1",
          ledger: USAGE_LEDGER,
          wallet: OPERATOR,
          points: 0,
          effective_block: BLOCK0 + 5,
          block_timestamp: dayTs(70, 30),
          cancel_reason: "manual cancel",
          cancelled_by: "enforcer",
          cancels_entry_id: target.entry_id,
        },
      ],
    });
    assert.equal(ofCode(cancelled, "O1")[0].status, "cancelled");
    assert.equal(walletPoints(cancelled, OPERATOR), 0);
    assert.equal(ofCode(cancelled, "ADJ").length, 1);
    const slash = play([log], {
      adjustments: [
        {
          adjustment_id: "adj-2",
          ledger: USAGE_LEDGER,
          wallet: OPERATOR,
          points: -4,
          effective_block: BLOCK0 + 5,
          block_timestamp: dayTs(70, 30),
          cancel_reason: "partial cancel",
          cancelled_by: "enforcer",
          cancels_entry_id: null,
        },
      ],
    });
    assert.equal(walletPoints(slash, OPERATOR), 6);
    const next = structuredClone(loaded.versions[0]);
    next.effective_from_block = BLOCK0 + 1000;
    next.config_version = "sepolia-draft-1";
    next.points = { ...next.points, O1: 4 };
    const mixed = play(
      [operatorSet(1, OPERATOR, BLOCK0 + 1, 71, 1), operatorSet(2, PAYER, BLOCK0 + 1000, 72, 1)],
      { versions: [loaded.versions[0], next] },
    );
    assert.equal(ofCode(mixed, "O1").find((row) => row.bot_id === bytes32(1)).points, 10);
    assert.equal(ofCode(mixed, "O1").find((row) => row.bot_id === bytes32(1)).config_version, "sepolia-draft-0");
    assert.equal(ofCode(mixed, "O1").find((row) => row.bot_id === bytes32(2)).points, 4);
    assert.equal(ofCode(mixed, "O1").find((row) => row.bot_id === bytes32(2)).config_version, "sepolia-draft-1");
  });

  it("ignores governance noise, pre-deploy logs, and denylist listings as points", () => {
    const liveVaultUpdated = {
      address: ESCROW,
      topics: ["0x161584aed96e7f34998117c9ad67e2d21ff46d2a42775c22b11ed282f3c7b2cd"],
      data: "0x",
      blockNumber: BLOCK0 + 1,
      logIndex: 0,
      blockHash: bytes32(0x444),
      transactionHash: bytes32(0x555),
      blockTimestamp: dayTs(80, 1),
    };
    const early = operatorSet(1, OPERATOR, 47294163, 0, 1);
    early.blockTimestamp = DAY0;
    const listed = businessLog({
      event: "Listed",
      address: DENYLIST,
      args: { id: bytes32(3), bucket: 0, actor: OPERATOR, timestamp: BigInt(dayTs(80, 1)), timesListed: 1n },
      blockNumber: BLOCK0 + 2,
      timestamp: dayTs(80, 1),
    });
    const burned = businessLog({
      event: "Burned",
      address: VAULT,
      args: { botId: bytes32(1), ts: BigInt(dayTs(80, 2)) },
      blockNumber: BLOCK0 + 3,
      timestamp: dayTs(80, 2),
    });
    const result = play([
      liveVaultUpdated,
      early,
      listed,
      burned,
      operatorSet(1, OPERATOR, BLOCK0 + 4, 80, 3),
    ]);
    assert.equal(ofCode(result, "O1").length, 1);
    assert.equal(ofCode(result, "O1")[0].points, 10);
    assert.equal(result.signals.some((signal) => signal.kind === "DENYLIST_LISTED"), true);
    assert.equal(result.signals.some((signal) => signal.kind === "BOT_BURNED"), true);
    assert.equal(result.entries.some((entry) => entry.points > 0 && entry.outcome_code !== "O1"), false);
  });
});

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    for (const rest of permutations(items.filter((_, index) => index !== i))) out.push([items[i], ...rest]);
  }
  return out;
}

function bump(versions, caps) {
  return versions.map((version, index) => {
    if (index !== 0) return version;
    const next = structuredClone(version);
    next.caps = { ...next.caps, ...caps };
    return next;
  });
}

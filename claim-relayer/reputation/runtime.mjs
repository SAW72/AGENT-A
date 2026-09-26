import { getAddress } from "viem";
import { httpError } from "../config.mjs";
import { createDefaultHooks } from "./hooks.mjs";
import { ARBITRATOR_LEDGER, USAGE_LEDGER, loadReputationConfig } from "./reputationConfig.mjs";
import { contribution, refuseReputationChain, replayLedger } from "./replay.mjs";

const BANNED_COPY = /\b(reward|earn|earnings|apy|yield|allocation)\b/i;

export const OUTCOME_LABELS = {
  O1: "Bot onboarded",
  O2: "Escrow completed without dispute",
  O3: "Refund path",
  O4: "Dispute path completed",
  O5: "Standalone dispute",
  A1: "Vote on an escrow-linked dispute",
  A2: "Vote matched the outcome",
  ADJ: "Manual adjustment",
};

export function createReputationRuntime(options = {}) {
  const loaded = options.versions ? { versions: options.versions, adjustments: options.adjustments || [], latest: options.versions[options.versions.length - 1] } : loadReputationConfig();
  const latest = loaded.latest || loaded.versions[loaded.versions.length - 1];
  assertCopy(latest.disclaimer);
  return {
    latest,
    replay() {
      return replayLedger({
        chainId: 84532,
        logs: options.logs || [],
        safeBlock: options.safeBlock,
        finalizedBlock: options.finalizedBlock,
        versions: options.versions,
        adjustments: options.adjustments,
        hooks: options.hooks || createDefaultHooks(),
      });
    },
  };
}

export function handleReputationRequest(runtime, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const match = path.match(/^\/v1\/reputation\/(0x[0-9a-fA-F]{40})(\/history)?$/);
  if (!match) {
    if (path === "/v1/reputation" || path.startsWith("/v1/reputation/")) {
      throw httpError(400, "invalid_address");
    }
    throw httpError(404, "not_found");
  }
  const chainParam = url.searchParams.get("chainId");
  if (chainParam !== null && chainParam !== "") refuseReputationChain(chainParam);
  let wallet;
  try {
    wallet = getAddress(match[1]);
  } catch {
    throw httpError(400, "invalid_address");
  }
  const ledger = url.searchParams.get("ledger");
  if (ledger && ledger !== USAGE_LEDGER && ledger !== ARBITRATOR_LEDGER) {
    throw httpError(400, "invalid_ledger");
  }
  const result = runtime.replay();
  if (match[2] === "/history") return historyBody(runtime, result, wallet, ledger, url);
  return balanceBody(runtime, result, wallet);
}

function balanceBody(runtime, result, wallet) {
  const latest = runtime.latest;
  return {
    ok: true,
    chainId: 84532,
    network: "base-sepolia",
    address: wallet,
    testnet_only: true,
    disclaimer: latest.disclaimer,
    disclaimer_links: latest.disclaimer_links,
    caps_draft: true,
    caps_label: latest.caps_label,
    config_version: latest.config_version,
    rule_version: latest.rule_version,
    ledgers: {
      [USAGE_LEDGER]: pointsFor(result, wallet, USAGE_LEDGER),
      [ARBITRATOR_LEDGER]: pointsFor(result, wallet, ARBITRATOR_LEDGER),
    },
    head: result.head,
  };
}

function historyBody(runtime, result, wallet, ledger, url) {
  const latest = runtime.latest;
  const limit = parseLimit(url.searchParams.get("limit"), latest);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  let rows = result.entries.filter((entry) => entry.wallet.toLowerCase() === wallet.toLowerCase());
  if (ledger) rows = rows.filter((entry) => entry.ledger === ledger);
  rows.sort(historyCmp);
  if (cursor) {
    const synthetic = { block_number: cursor.b, log_index: cursor.l, entry_id: cursor.e };
    rows = rows.filter((entry) => historyCmp(synthetic, entry) < 0);
  }
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  return {
    ok: true,
    chainId: 84532,
    network: "base-sepolia",
    address: wallet,
    ledger: ledger || null,
    testnet_only: true,
    disclaimer: latest.disclaimer,
    disclaimer_links: latest.disclaimer_links,
    caps_draft: true,
    caps_label: latest.caps_label,
    entries: page.map(historyRow),
    next_cursor: next,
  };
}

function pointsFor(result, wallet, ledger) {
  let finalPoints = 0;
  let provisionalPoints = 0;
  for (const entry of result.entries) {
    if (entry.ledger !== ledger) continue;
    if (entry.wallet.toLowerCase() !== wallet.toLowerCase()) continue;
    const points = contribution(entry);
    if (entry.status === "final") finalPoints += points;
    else if (entry.status === "provisional") provisionalPoints += points;
  }
  return { final_points: finalPoints, provisional_points: provisionalPoints };
}

function historyRow(entry) {
  return {
    entry_id: entry.entry_id,
    semantic_key: entry.semantic_key,
    ledger: entry.ledger,
    chain_id: entry.chain_id,
    wallet: entry.wallet,
    bot_id: entry.bot_id,
    outcome_code: entry.outcome_code,
    outcome_label: OUTCOME_LABELS[entry.outcome_code] || entry.outcome_code,
    points: entry.points,
    nominal_points: entry.nominal_points,
    capped: entry.capped,
    cap_name: entry.cap_name,
    status: entry.status,
    source_contract: entry.source_contract,
    event_names: entry.event_names,
    tx_hash: entry.tx_hash,
    log_index: entry.log_index,
    block_number: entry.block_number,
    block_hash: entry.block_hash,
    block_timestamp: entry.block_timestamp,
    escrow_id: entry.escrow_id,
    dispute_id: entry.dispute_id,
    rule_version: entry.rule_version,
    config_version: entry.config_version,
    cancel_reason: entry.cancel_reason,
    cancelled_by: entry.cancelled_by,
    eligible: entry.eligible,
    eligibility_reason: entry.eligibility_reason,
    enforcer_withheld: entry.enforcer_withheld,
    role: entry.role,
  };
}

function historyCmp(a, b) {
  if (a.block_number !== b.block_number) return b.block_number - a.block_number;
  const ai = a.log_index ?? Number.MAX_SAFE_INTEGER;
  const bi = b.log_index ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return bi - ai;
  return b.entry_id.localeCompare(a.entry_id);
}

function parseLimit(raw, latest) {
  if (raw === null || raw === "") return latest.read_api.history_page_default;
  if (!/^[0-9]+$/.test(raw)) throw httpError(400, "invalid_limit");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > latest.read_api.history_page_max) {
    throw httpError(400, "invalid_limit");
  }
  return limit;
}

function parseCursor(raw) {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const logIndex = parsed.l === null ? null : parsed.l;
    if (!Number.isSafeInteger(parsed.b) || typeof parsed.e !== "string") return badCursor();
    if (logIndex !== null && !Number.isSafeInteger(logIndex)) return badCursor();
    return { b: parsed.b, l: logIndex, e: parsed.e };
  } catch (err) {
    if (err.error === "invalid_cursor") throw err;
    return badCursor();
  }
}

function badCursor() {
  throw httpError(400, "invalid_cursor");
}

function encodeCursor(entry) {
  return Buffer.from(
    JSON.stringify({ b: entry.block_number, l: entry.log_index, e: entry.entry_id }),
    "utf8",
  ).toString("base64url");
}

function assertCopy(text) {
  if (!text || BANNED_COPY.test(text)) throw httpError(500, "reputation_copy_rejected");
}

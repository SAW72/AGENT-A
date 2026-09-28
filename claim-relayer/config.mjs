/**
 * Base Sepolia (chainId 84532) only.
 * This module never reads RELAYER_PRIVATE_KEY and never opens an RPC client.
 * Escrow defaults from deployments/base-sepolia.json when ESCROW_ADDRESS is unset.
 */

import { loadAddressBook, DEFAULT_ADDRESS_BOOK, parseStartBlock, rejectRetiredAddress } from "./addressBook.mjs";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const DEFAULT_RELAYER_ADDRESS = "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Booked BotAttestationEscrow on Base Sepolia. Live submit refuses every other target. */
export const BOOKED_SEPOLIA_ESCROW = "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d";
/** ESC-M-1 deploy block. Indexer and relayer log scans start here. */
export const BOOKED_SEPOLIA_ESCROW_START_BLOCK = 47345163;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAINNET_CHAIN_IDS = new Set([1, 8453]);

export function parseEnvFlag(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isAddress(value) {
  return ADDRESS_RE.test(String(value || "").trim());
}

/** Preserve checksum casing. Return null when the shape is wrong. */
export function checkedAddress(value) {
  const s = String(value || "").trim();
  if (!ADDRESS_RE.test(s)) return null;
  return s;
}

export function httpError(status, error, extra = {}) {
  return Object.assign(new Error(error), { status, error, ...extra });
}

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

/**
 * Live submit is allowed only when every gate passes:
 * chain id 84532, LIVE_SUBMIT=1, SPENCER_RUN_AUTH=1, and the booked Sepolia escrow.
 * Chain ids 1 and 8453 never pass. This function does not read a key or open an RPC.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {boolean | { escrowBooked?: boolean, escrowAddress?: string | null, chainId?: number }} escrow
 */
export function liveSubmitStatus(env, escrow = {}) {
  const booked = typeof escrow === "boolean" ? { escrowBooked: escrow } : escrow || {};
  const chainId = Number(booked.chainId === undefined ? BASE_SEPOLIA_CHAIN_ID : booked.chainId);
  const requested = parseEnvFlag(env.LIVE_SUBMIT);
  const spencerAuth = parseEnvFlag(env.SPENCER_RUN_AUTH);
  const blockers = [];
  if (MAINNET_CHAIN_IDS.has(chainId)) blockers.push("mainnet_refused");
  else if (!Number.isInteger(chainId) || chainId !== BASE_SEPOLIA_CHAIN_ID) blockers.push("wrong_chain");
  if (!booked.escrowBooked) blockers.push("escrow_not_booked");
  else if (!sameAddress(booked.escrowAddress, BOOKED_SEPOLIA_ESCROW)) blockers.push("escrow_not_booked_sepolia");
  if (!spencerAuth) blockers.push("spencer_run_auth_required");
  if (!requested) blockers.push("live_submit_off");
  const allowed = blockers.length === 0;
  return {
    requested,
    allowed,
    spencerAuth,
    error: allowed ? null : "live_submit_blocked",
    blockers,
  };
}

function isMissingStartBlock(raw) {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "string" && raw.trim() === "") return true;
  return false;
}

/**
 * The booked start block belongs to the booked escrow only.
 * When the configured escrow is that contract, use the address-book block, or the
 * constant when the book omits one. A different contract never inherits that block:
 * ESCROW_START_BLOCK supplies it, or the value stays null (source "unset").
 * Null is not block 0. Callers must not coalesce null to 0 or to BOOKED_SEPOLIA_ESCROW_START_BLOCK.
 */
function resolveEscrowStartBlock(env, escrowAddress, book) {
  if (!escrowAddress) {
    return { escrowStartBlock: null, escrowStartBlockSource: "unbooked" };
  }
  const matchesBookSlot = book.escrowAddress && sameAddress(escrowAddress, book.escrowAddress);
  if (matchesBookSlot && book.escrowStartBlock != null) {
    return { escrowStartBlock: book.escrowStartBlock, escrowStartBlockSource: "address_book" };
  }
  if (sameAddress(escrowAddress, BOOKED_SEPOLIA_ESCROW)) {
    return { escrowStartBlock: BOOKED_SEPOLIA_ESCROW_START_BLOCK, escrowStartBlockSource: "booked_constant" };
  }
  const raw = env.ESCROW_START_BLOCK;
  if (isMissingStartBlock(raw)) {
    return { escrowStartBlock: null, escrowStartBlockSource: "unset" };
  }
  const parsed = parseStartBlock(raw);
  if (parsed == null) {
    throw Object.assign(
      new Error(
        "ESCROW_START_BLOCK must be a non-negative integer. The booked start block is not used when ESCROW_ADDRESS is a different contract.",
      ),
      { status: 400, error: "invalid_escrow_start_block" },
    );
  }
  return { escrowStartBlock: parsed, escrowStartBlockSource: "env" };
}

function resolveEscrow(env) {
  const book = loadAddressBook(env.ADDRESS_BOOK_PATH || DEFAULT_ADDRESS_BOOK);
  const guard = { forbidden: book.forbidden, replacements: book.replacements };
  rejectRetiredAddress(book.disputePanelAddress, guard);
  rejectRetiredAddress(book.denylistAddress, guard);
  rejectRetiredAddress(book.vaultAddress, guard);

  const explicit = env.ESCROW_ADDRESS === undefined ? "" : String(env.ESCROW_ADDRESS).trim();
  let escrowAddress = book.escrowAddress;
  let escrowBooked = book.escrowBooked;
  let escrowSource = "address_book";
  if (explicit) {
    const parsed = checkedAddress(explicit);
    if (!parsed) throw httpError(400, "invalid_escrow_address");
    if (parsed.toLowerCase() === ZERO_ADDRESS) {
      escrowAddress = null;
      escrowBooked = false;
      escrowSource = "env_cleared";
    } else {
      escrowAddress = parsed;
      escrowBooked = true;
      escrowSource = "env";
    }
  }
  rejectRetiredAddress(escrowAddress, guard);
  return {
    disputePanelAddress: book.disputePanelAddress,
    coreTimelock: book.coreTimelock,
    escrowOwner: book.escrowOwner,
    bvtAddress: book.bvtAddress,
    escrowAddress,
    escrowBooked,
    escrowSource,
    ...resolveEscrowStartBlock(env, escrowAddress, book),
  };
}

function positiveInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw httpError(400, "invalid_abuse_limit");
  }
  return parsed;
}

function parseWei(value, fallback, error) {
  const text = value === undefined || value === null || String(value).trim() === "" ? fallback : String(value).trim();
  if (!/^[0-9]+$/.test(text)) throw httpError(400, error);
  return BigInt(text);
}

/**
 * Safe defaults. Counts are per window, not authentication.
 * sender: 5 / minute. IP: 30 / minute. escrow: 8 / day. gas: 0.01 ETH / day at 1 gwei.
 */
export function loadAbuseLimits(env) {
  return {
    senderLimit: positiveInt(env.CLAIM_RATE_SENDER, 5),
    ipLimit: positiveInt(env.CLAIM_RATE_IP, 30),
    windowMs: positiveInt(env.CLAIM_RATE_WINDOW_SEC, 60) * 1000,
    escrowCap: positiveInt(env.CLAIM_ESCROW_CAP, 8),
    escrowWindowMs: positiveInt(env.CLAIM_ESCROW_WINDOW_SEC, 86400) * 1000,
    dailyGasBudgetWei: parseWei(env.DAILY_GAS_BUDGET_WEI, "10000000000000000", "invalid_gas_budget").toString(),
    gasPriceWei: parseWei(env.CLAIM_GAS_PRICE_WEI, "1000000000", "invalid_gas_price").toString(),
  };
}

export function loadConfig(env = process.env) {
  if (env.RELAYER_KEY_FILE || env.RELAYER_PRIVATE_KEY_FILE) {
    throw httpError(500, "key_file_forbidden");
  }

  const chainText = env.CHAIN_ID === undefined ? "" : String(env.CHAIN_ID).trim();
  const chainId = chainText === "" ? BASE_SEPOLIA_CHAIN_ID : Number(chainText);
  if (!Number.isInteger(chainId)) {
    throw httpError(400, "wrong_chain", { chainId: chainText });
  }
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    const error = MAINNET_CHAIN_IDS.has(chainId) ? "mainnet_refused" : "wrong_chain";
    throw httpError(400, error, { chainId });
  }

  let relayerAddress = DEFAULT_RELAYER_ADDRESS;
  if (env.RELAYER_ADDRESS !== undefined && String(env.RELAYER_ADDRESS).trim() !== "") {
    const parsed = checkedAddress(env.RELAYER_ADDRESS);
    if (!parsed || parsed.toLowerCase() === ZERO_ADDRESS) {
      throw httpError(400, "invalid_relayer_address");
    }
    relayerAddress = parsed;
  }

  const escrow = resolveEscrow(env);

  const port = Number(env.PORT === undefined || String(env.PORT).trim() === "" ? 8790 : env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw httpError(400, "invalid_port");
  }

  const ttlRaw = Number(env.QUOTE_TTL_MS || 30 * 60 * 1000);
  const quoteTtlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : 30 * 60 * 1000;
  const abuse = loadAbuseLimits(env);

  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    network: "base-sepolia",
    port,
    host: env.HOST || (env.RENDER ? "0.0.0.0" : "127.0.0.1"),
    relayerAddress,
    escrowAddress: escrow.escrowAddress,
    escrowStartBlock: escrow.escrowStartBlock,
    escrowStartBlockSource: escrow.escrowStartBlockSource,
    escrowBooked: escrow.escrowBooked,
    escrowSource: escrow.escrowSource,
    disputePanelAddress: escrow.disputePanelAddress,
    coreTimelock: escrow.coreTimelock,
    escrowOwner: escrow.escrowOwner,
    bvtAddress: escrow.bvtAddress,
    adminSecret: String(env.ADMIN_SECRET || "").trim(),
    killSwitchInitial: parseEnvFlag(env.KILL_SWITCH),
    claimLogPath: String(env.CLAIM_LOG_PATH || "./data/claims.jsonl"),
    intentNoncePath: String(env.INTENT_NONCE_PATH || "./data/intent-nonces.jsonl"),
    erc1271Enabled: parseEnvFlag(env.ERC1271_ENABLED),
    abuse,
    quoteTtlMs,
    liveSubmit: liveSubmitStatus(env, {
      escrowBooked: escrow.escrowBooked,
      escrowAddress: escrow.escrowAddress,
      chainId: BASE_SEPOLIA_CHAIN_ID,
    }),
    corsOrigins:
      env.CORS_ORIGINS ||
      "https://agent-a-wallet-ux.pages.dev,http://localhost:5173,http://127.0.0.1:5173",
  };
}

export function healthPayload(config, killSwitchOn) {
  const live = Boolean(config.liveSubmit?.allowed);
  return {
    ok: true,
    chainId: config.chainId,
    network: config.network,
    killSwitch: Boolean(killSwitchOn),
    mode: live ? "live" : "fixture",
    stub: !live,
    fixture: !live,
    escrowBooked: config.escrowBooked,
    escrowAddress: config.escrowAddress,
    escrowSource: config.escrowSource,
    escrowStartBlock: config.escrowStartBlock ?? null,
    escrowStartBlockSource: config.escrowStartBlockSource ?? null,
    relayerAddress: config.relayerAddress,
    liveSubmit: live,
    liveSubmitRequested: Boolean(config.liveSubmit?.requested),
    liveSubmitBlockers: config.liveSubmit?.blockers ?? [],
  };
}

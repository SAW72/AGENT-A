import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { ESCROW_VIEW_SIGNATURES, PANEL_VIEW_SIGNATURES, selectorFor } from "./escrowCalldata.mjs";

/** Read-only JSON-RPC methods. Anything else is refused before the request is sent. */
export const ALLOWED_RPC_METHODS = Object.freeze(["eth_chainId", "eth_call", "eth_getCode"]);

function rpcError(error, extra = {}) {
  return Object.assign(new Error(error), { error, ...extra });
}

async function rpc(fetchImpl, rpcUrl, method, params) {
  if (!ALLOWED_RPC_METHODS.includes(method)) throw rpcError("rpc_method_refused", { method });
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await response.json();
  if (!json || json.error) {
    throw rpcError("rpc_error", { method });
  }
  return json.result;
}

function callData(signature) {
  return selectorFor(signature);
}

export function decodeAddress(word) {
  const hex = String(word || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 40) throw rpcError("bad_address_word");
  return "0x" + hex.slice(-40);
}

export function decodeUint(word) {
  const hex = String(word || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length === 0) throw rpcError("bad_uint_word");
  return BigInt("0x" + hex);
}

function sameAddress(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function normalizeAddress(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed) || trimmed.toLowerCase() === ZERO_ADDRESS) return null;
  return trimmed;
}

/**
 * Expected owner is `NEW_TIMELOCK` from the environment when that is a real address,
 * otherwise `governanceTimelock` from the address book. Blank, zero, and missing are unset.
 * The field is not filled in with CORE. CORE is a separate owner check in `assessOwner`.
 * @param {string | undefined | null} envValue
 * @param {string | undefined | null} bookValue
 * @returns {string | null}
 */
export function readExpectedOwner(envValue, bookValue) {
  return normalizeAddress(envValue) || normalizeAddress(bookValue);
}

/**
 * Escrow migration is opt-in, so CORE may stay the owner permanently.
 * Pass first when the on-chain owner is the labeled pre-migration CORE owner, even if the
 * expected-owner field is unset. That result is labeled pre-migration/legacy.
 * Otherwise pass when the owner equals the configured `governanceTimelock` / `NEW_TIMELOCK`.
 * If the field is unset and the owner is not CORE, fail closed.
 * Any other owner fails closed.
 * @param {string | null | undefined} owner
 * @param {string | null | undefined} expectedOwner
 * @param {string | null | undefined} preMigrationOwner
 */
export function assessOwner(owner, expectedOwner, preMigrationOwner) {
  if (preMigrationOwner && sameAddress(owner, preMigrationOwner)) {
    return {
      ok: true,
      code: "pre_migration_core",
      message: "pre-migration/legacy: on-chain owner is CORE",
    };
  }
  if (expectedOwner && sameAddress(owner, expectedOwner)) {
    return {
      ok: true,
      code: "configured_owner",
      message: "on-chain owner matches the configured timelock",
    };
  }
  if (!expectedOwner) {
    return {
      ok: false,
      code: "expected_owner_unset",
      message:
        "expected owner is unset and the on-chain owner is not the pre-migration CORE owner; set NEW_TIMELOCK or governanceTimelock",
    };
  }
  return {
    ok: false,
    code: "owner_mismatch",
    message: "on-chain owner matches neither the configured timelock nor the pre-migration CORE owner",
  };
}

/**
 * Read Escrow owner, governance, disputePanel, and panel arbitratorCount.
 * Refuses any chain other than Base Sepolia before further calls.
 * @param {object} opts
 * @param {string} opts.rpcUrl
 * @param {string} opts.escrowAddress
 * @param {string | null} [opts.disputePanelAddress]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string | null} [opts.expectedOwner]
 * @param {string | null} [opts.expectedGovernance]
 * @param {string | null} [opts.expectedDisputePanel]
 */
export async function readEscrowState(opts) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const chainHex = await rpc(fetchImpl, opts.rpcUrl, "eth_chainId", []);
  const chainId = Number(chainHex);
  if (chainId === 1 || chainId === 8453) throw rpcError("mainnet_refused", { chainId });
  if (chainId !== 84532) throw rpcError("wrong_chain", { chainId });
  if (!opts.escrowAddress) throw rpcError("escrow_not_booked");

  const code = await rpc(fetchImpl, opts.rpcUrl, "eth_getCode", [opts.escrowAddress, "latest"]);
  const owner = decodeAddress(
    await rpc(fetchImpl, opts.rpcUrl, "eth_call", [
      { to: opts.escrowAddress, data: callData(ESCROW_VIEW_SIGNATURES.owner) },
      "latest",
    ]),
  );
  const governance = decodeAddress(
    await rpc(fetchImpl, opts.rpcUrl, "eth_call", [
      { to: opts.escrowAddress, data: callData(ESCROW_VIEW_SIGNATURES.governance) },
      "latest",
    ]),
  );
  const disputePanel = decodeAddress(
    await rpc(fetchImpl, opts.rpcUrl, "eth_call", [
      { to: opts.escrowAddress, data: callData(ESCROW_VIEW_SIGNATURES.disputePanel) },
      "latest",
    ]),
  );
  let arbitratorCount = null;
  if (opts.disputePanelAddress) {
    arbitratorCount = decodeUint(
      await rpc(fetchImpl, opts.rpcUrl, "eth_call", [
        { to: opts.disputePanelAddress, data: callData(PANEL_VIEW_SIGNATURES.arbitratorCount) },
        "latest",
      ]),
    );
  }

  return {
    chainId,
    escrowAddress: opts.escrowAddress,
    hasCode: Boolean(code && code !== "0x" && code !== "0x0"),
    owner,
    governance,
    disputePanel,
    arbitratorCount: arbitratorCount === null ? null : arbitratorCount.toString(),
    bookMatch: {
      owner: opts.expectedOwner ? sameAddress(owner, opts.expectedOwner) : null,
      governance: opts.expectedGovernance ? sameAddress(governance, opts.expectedGovernance) : null,
      disputePanel: opts.expectedDisputePanel ? sameAddress(disputePanel, opts.expectedDisputePanel) : null,
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadConfig(process.env);
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const expectedOwner = readExpectedOwner(process.env.NEW_TIMELOCK, config.governanceTimelock);
  try {
    const state = await readEscrowState({
      rpcUrl,
      escrowAddress: config.escrowAddress,
      disputePanelAddress: config.disputePanelAddress,
      expectedOwner,
      expectedGovernance: config.coreTimelock,
      expectedDisputePanel: config.disputePanelAddress,
    });
    const ownerCheck = assessOwner(state.owner, expectedOwner, config.coreTimelock);
    console.log(JSON.stringify({ ...state, ownerCheck: ownerCheck.code }));
    if (!ownerCheck.ok) {
      console.error(ownerCheck.message);
      process.exitCode = 2;
    } else if (!state.hasCode || state.bookMatch.governance === false || state.bookMatch.disputePanel === false) {
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(err.error || err.message || "readonly_failed");
    process.exit(1);
  }
}

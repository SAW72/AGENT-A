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
  try {
    const state = await readEscrowState({
      rpcUrl,
      escrowAddress: config.escrowAddress,
      disputePanelAddress: config.disputePanelAddress,
      expectedOwner: config.escrowOwner,
      expectedGovernance: config.coreTimelock,
      expectedDisputePanel: config.disputePanelAddress,
    });
    console.log(JSON.stringify(state));
    if (!state.hasCode || state.bookMatch.owner === false || state.bookMatch.governance === false || state.bookMatch.disputePanel === false) {
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(err.error || err.message || "readonly_failed");
    process.exit(1);
  }
}

import { httpError } from "./config.mjs";
import { selectorFor } from "./escrowCalldata.mjs";

/**
 * `usedEscrowIds(id)` is the replay bit set in the same transaction as the
 * escrow struct. Unset storage is false. `escrows(id).payer` is also zero for
 * a never-created id, but the bool is the dedicated existence signal and stays
 * true after release or refund. `createEscrow` is excluded: that id is new.
 */
export const USED_ESCROW_IDS_SIGNATURE = "usedEscrowIds(bytes32)";

const EXISTING_ESCROW_ACTIONS = new Set(["release", "refund", "dispute"]);

export function actionNeedsEscrow(action) {
  return EXISTING_ESCROW_ACTIONS.has(action);
}

export function usedEscrowIdsCalldata(escrowId) {
  const text = String(escrowId || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) {
    throw httpError(400, "invalid_bytes32", { field: "claimId", txHash: null, dryRun: false });
  }
  return selectorFor(USED_ESCROW_IDS_SIGNATURE) + text.slice(2).toLowerCase();
}

/** First ABI word of release, refund, dispute, and createEscrow is the escrow id. */
export function escrowIdFromEncoded(calldata) {
  const hex = String(calldata || "");
  if (!/^0x[0-9a-fA-F]{8}[0-9a-fA-F]{64}/.test(hex)) return null;
  return "0x" + hex.slice(10, 74).toLowerCase();
}

export function decodeUsedEscrowId(word) {
  const hex = String(word ?? "").trim();
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    return BigInt(hex) !== 0n;
  } catch {
    return null;
  }
}

function readFailed() {
  return httpError(502, "escrow_read_failed", { txHash: null, dryRun: false });
}

/**
 * eth_call `usedEscrowIds(id)` at block `latest`. Throws 404 `escrow_not_found`
 * when the id was never created. Does not estimate gas and does not broadcast.
 * @param {object} args
 * @param {(args: { method: string, params?: unknown[] }) => Promise<unknown>} args.request
 * @param {string | null | undefined} args.escrowAddress
 * @param {string} args.escrowId
 */
export async function assertEscrowExists({ request, escrowAddress, escrowId }) {
  if (typeof request !== "function" || !escrowAddress) throw readFailed();
  const data = usedEscrowIdsCalldata(escrowId);
  let result;
  try {
    result = await request({
      method: "eth_call",
      params: [{ to: escrowAddress, data }, "latest"],
    });
  } catch (err) {
    if (err?.status && err?.error) throw err;
    throw readFailed();
  }
  const used = decodeUsedEscrowId(result);
  if (used === null) throw readFailed();
  if (!used) throw httpError(404, "escrow_not_found", { txHash: null });
}

/**
 * JSON-RPC reader for the existence check. eth_call only.
 * @param {object} [opts]
 * @param {string} [opts.rpcUrl]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createEscrowRpc({ rpcUrl, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const url = rpcUrl || "https://sepolia.base.org";
  return async function request(args) {
    const method = args?.method;
    if (method !== "eth_call") throw httpError(400, "rpc_method_refused", { method, txHash: null });
    let json;
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: args?.params ?? [] }),
      });
      json = await response.json();
    } catch {
      throw readFailed();
    }
    if (!json || json.error || json.result === undefined || json.result === null) throw readFailed();
    return json.result;
  };
}

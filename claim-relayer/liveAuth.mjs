/**
 * Live POST /v1/claims authorization.
 * Verification order is fixed:
 *   1. domain chainId + verifyingContract
 *   2. deadline window
 *   3. signer (ECDSA, then ERC-1271 only when enabled)
 *   4. sender is payer or payee of an escrow that exists at latest
 *   5. calldata hash and allowlisted selector
 *   6. (sender, nonce) single-use store
 * Only then does the caller simulate and broadcast.
 * Abuse limits run after the signature checks and before simulation.
 * A replay returns the stored result and does not broadcast.
 */

import { DEADLINE_WINDOW_SECONDS, assertCalldataBinding, assertIntentDeadline, assertIntentDomain, assertIntentSigner, nonceKey, parseClaimIntent } from "./claimIntent.mjs";
import { httpError } from "./config.mjs";
import { claimActionMeta } from "./escrowCalldata.mjs";
import { parseAmountWei } from "./claims.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function gasWeiFor(gasUsed, valueWei, gasPriceWei) {
  const gas = gasUsed > 0n ? gasUsed : 120_000n;
  const price = gasPriceWei > 0n ? gasPriceWei : 1_000_000_000n;
  const value = BigInt(valueWei || "0");
  return gas * price + value;
}

/**
 * @param {object} args
 * @param {object} args.body
 * @param {ReturnType<import('./config.mjs').loadConfig>} args.config
 * @param {{ readEscrow: Function, isValidSignature: Function, simulate: Function }} args.chain
 * @param {{ claim: Function }} args.intentNonces
 * @param {{ check: Function, consume: Function }} args.abuse
 * @param {number} args.nowMs
 * @param {string} args.ip
 */
export async function prepareLiveClaim(args) {
  const { body, config, chain, intentNonces, abuse, nowMs, ip } = args;
  const intent = parseClaimIntent(body);
  assertIntentDomain(intent, config);
  assertIntentDeadline(intent, nowMs);
  await assertIntentSigner(intent, config, chain);

  if (!chain || typeof chain.readEscrow !== "function") {
    throw httpError(503, "escrow_reader_missing", { txHash: null, dryRun: false });
  }
  const record = await chain.readEscrow(intent.escrowId);
  if (!record?.exists || sameAddress(record.payer, ZERO)) {
    throw httpError(404, "escrow_not_found", { txHash: null, dryRun: false });
  }
  const senderIsParty =
    sameAddress(intent.sender, record.payer) || sameAddress(intent.sender, record.payee);
  if (!senderIsParty) throw httpError(403, "not_a_party", { txHash: null, dryRun: false });

  assertCalldataBinding(intent);

  const described = claimActionMeta(intent.action);
  let valueWei = "0";
  if (intent.action === "createEscrow") {
    valueWei = parseAmountWei(body.amountWei);
    if (!valueWei) throw httpError(400, "invalid_amount");
  } else if (body.amountWei !== undefined && body.amountWei !== null && String(body.amountWei).trim() !== "") {
    throw httpError(400, "value_not_allowed");
  }
  const key = nonceKey(intent.sender, intent.nonce);
  const ttlMs = Math.max(DEADLINE_WINDOW_SECONDS * 1000, Number(intent.deadline) * 1000 - nowMs);

  const claimed = await intentNonces.claim({ key, ttlMs, atMs: nowMs });
  if (claimed.kind === "replay") {
    return { kind: "replay", status: claimed.result.status, body: claimed.result.body, nonceKey: key };
  }
  if (claimed.kind === "pending") {
    throw httpError(409, "nonce_in_flight", { txHash: null, dryRun: false });
  }

  const encoded = {
    action: intent.action,
    signature: described.signature,
    selector: described.selector,
    calldata: intent.calldata,
    valueWei,
    calldataStatus: "encoded",
    senderConstraint: described.senderConstraint,
  };

  try {
    await abuse.check({
      sender: intent.sender,
      ip,
      escrowId: intent.escrowId,
      gasWei: 0n,
      atMs: nowMs,
    });
  } catch (err) {
    err.nonceClaimed = true;
    err.nonceKey = key;
    throw err;
  }

  let simulation;
  try {
    simulation = await chain.simulate({
      to: config.escrowAddress,
      data: intent.calldata,
      valueWei,
    });
  } catch (err) {
    err.nonceClaimed = true;
    err.nonceKey = key;
    throw err;
  }
  if (!simulation?.ok) {
    throw Object.assign(httpError(502, "broadcast_failed", {
      txHash: null,
      dryRun: false,
      revert_data: simulation?.revertData ?? null,
      action: intent.action,
      senderConstraint: described.senderConstraint,
    }), { nonceClaimed: true, nonceKey: key });
  }

  const gasWei = gasWeiFor(BigInt(simulation.gasUsed ?? 0), valueWei, BigInt(config.abuse.gasPriceWei));
  try {
    await abuse.consume({
      sender: intent.sender,
      ip,
      escrowId: intent.escrowId,
      gasWei,
      atMs: nowMs,
    });
  } catch (err) {
    err.nonceClaimed = true;
    err.nonceKey = key;
    throw err;
  }

  return {
    kind: "ready",
    nonceKey: key,
    encoded,
    claimId: intent.escrowId,
    sender: intent.sender,
  };
}

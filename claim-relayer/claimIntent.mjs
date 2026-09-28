/**
 * EIP-712 ClaimIntent. The JSON file is the single schema shared with wallet-ux.
 * Action enum order is the `actions` array: 0 createEscrow, 1 release, 2 refund, 3 dispute.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getAddress,
  hexToBytes,
  isAddress,
  isHex,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
} from "viem";
import { SUPERSEDED } from "./addressBook.mjs";
import { httpError } from "./config.mjs";
import { ESCROW_SIGNATURES, selectorFor } from "./escrowCalldata.mjs";

export const CLAIM_INTENT_SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL("./claimIntent.json", import.meta.url)), "utf8"),
);

export const CLAIM_INTENT_TYPE_STRING = CLAIM_INTENT_SCHEMA.typeString;
export const CLAIM_INTENT_TYPEHASH = keccak256(toBytes(CLAIM_INTENT_TYPE_STRING));
export const DEADLINE_WINDOW_SECONDS = CLAIM_INTENT_SCHEMA.deadlineWindowSeconds;
export const RETIRED_ESCROW = SUPERSEDED.botAttestationEscrow;

const ACTION_INDEX = new Map(CLAIM_INTENT_SCHEMA.actions.map((name, index) => [name, index]));
const INDEX_ACTION = new Map(CLAIM_INTENT_SCHEMA.actions.map((name, index) => [index, name]));

const SELECTOR_ACTION = new Map(
  Object.entries(ESCROW_SIGNATURES).map(([action, signature]) => [selectorFor(signature), action]),
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function claimIntentTypes() {
  return { ClaimIntent: CLAIM_INTENT_SCHEMA.types.ClaimIntent.map((field) => ({ ...field })) };
}

export function claimIntentDomain(chainId, verifyingContract) {
  return {
    name: CLAIM_INTENT_SCHEMA.domainName,
    version: CLAIM_INTENT_SCHEMA.domainVersion,
    chainId: Number(chainId),
    verifyingContract: getAddress(verifyingContract),
  };
}

export function actionIndex(action) {
  if (typeof action === "number" && INDEX_ACTION.has(action)) return action;
  if (typeof action === "bigint" && INDEX_ACTION.has(Number(action))) return Number(action);
  const name = String(action ?? "").trim();
  if (!ACTION_INDEX.has(name)) return null;
  return ACTION_INDEX.get(name);
}

export function actionName(action) {
  const index = actionIndex(action);
  if (index === null) return null;
  return INDEX_ACTION.get(index);
}

function sameAddress(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function parseBytes32(value, field) {
  const text = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text) || /^0x0{64}$/i.test(text)) {
    throw httpError(400, "invalid_bytes32", { field });
  }
  return text.toLowerCase();
}

function parseUint256(value, field) {
  if (typeof value === "bigint") {
    if (value < 0n || value >= 2n ** 256n) throw httpError(400, field);
    return value;
  }
  const text = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(text)) throw httpError(400, field);
  const parsed = BigInt(text);
  if (parsed >= 2n ** 256n) throw httpError(400, field);
  return parsed;
}

function parseDeadline(value) {
  const parsed = parseUint256(value, "invalid_deadline");
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw httpError(400, "invalid_deadline");
  return parsed;
}

/**
 * Pull the signed intent off a live claim body.
 * Domain name and version are the schema constants. chainId and verifyingContract
 * come from the client so they can be rejected before recovery.
 */
export function parseClaimIntent(body) {
  const intent = body?.intent;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw httpError(400, "intent_required");
  }
  const signature = String(body.signature ?? "").trim();
  if (!isHex(signature) || signature.length < 10) throw httpError(400, "invalid_signature");
  const calldata = String(body.calldata ?? "").trim();
  if (!isHex(calldata) || calldata.length < 10) throw httpError(400, "invalid_calldata");

  const action = actionName(intent.action);
  if (!action) throw httpError(400, "action_not_claim", { field: "action" });
  const escrowId = parseBytes32(intent.escrowId, "escrowId");
  const calldataHash = parseBytes32(intent.calldataHash, "calldataHash");
  const senderText = String(intent.sender ?? "").trim();
  if (!isAddress(senderText) || sameAddress(senderText, ZERO_ADDRESS)) {
    throw httpError(400, "invalid_address", { field: "sender" });
  }
  const nonce = parseUint256(intent.nonce, "invalid_nonce");
  if (nonce === 0n) throw httpError(400, "invalid_nonce");
  const deadline = parseDeadline(intent.deadline);

  if (intent.chainId === undefined || intent.chainId === null || intent.chainId === "") {
    throw httpError(400, "wrong_chain");
  }
  const chainId = Number(intent.chainId);
  if (!Number.isInteger(chainId)) throw httpError(400, "wrong_chain", { chainId: intent.chainId });

  const verifyingText = String(intent.verifyingContract ?? "").trim();
  if (!isAddress(verifyingText) || sameAddress(verifyingText, ZERO_ADDRESS)) {
    throw httpError(400, "invalid_address", { field: "verifyingContract" });
  }

  return {
    action,
    actionIndex: actionIndex(action),
    escrowId,
    calldataHash,
    sender: getAddress(senderText),
    nonce,
    deadline,
    chainId,
    verifyingContract: getAddress(verifyingText),
    signature,
    calldata,
  };
}

/**
 * Step 1. Domain chain id and verifying contract must be this relayer's escrow.
 * The retired escrow is rejected even when it is not the configured address.
 */
export function assertIntentDomain(intent, config) {
  if (sameAddress(intent.verifyingContract, RETIRED_ESCROW)) {
    throw httpError(400, "retired_or_superseded_address", {
      address: intent.verifyingContract,
      current: config.escrowAddress,
    });
  }
  if (intent.chainId === 1 || intent.chainId === 8453) {
    throw httpError(400, "mainnet_refused", { chainId: intent.chainId });
  }
  if (intent.chainId !== config.chainId) {
    throw httpError(400, "wrong_chain", { chainId: intent.chainId });
  }
  if (!config.escrowAddress || !sameAddress(intent.verifyingContract, config.escrowAddress)) {
    throw httpError(409, "domain_mismatch", {
      escrowAddress: config.escrowAddress,
    });
  }
}

/** Step 2. deadline is in the future and no more than 300 seconds ahead. */
export function assertIntentDeadline(intent, nowMs) {
  const nowSeconds = BigInt(Math.floor(Number(nowMs) / 1000));
  if (intent.deadline <= nowSeconds) throw httpError(400, "deadline_expired");
  if (intent.deadline - nowSeconds > BigInt(DEADLINE_WINDOW_SECONDS)) {
    throw httpError(400, "deadline_too_far");
  }
}

export function typedDataFor(intent, config) {
  return {
    domain: claimIntentDomain(config.chainId, config.escrowAddress),
    types: claimIntentTypes(),
    primaryType: CLAIM_INTENT_SCHEMA.primaryType,
    message: {
      action: intent.actionIndex,
      escrowId: intent.escrowId,
      calldataHash: intent.calldataHash,
      sender: intent.sender,
      nonce: intent.nonce,
      deadline: intent.deadline,
    },
  };
}

/**
 * Step 3. Recovered signer equals intent.sender.
 * ERC-1271 runs only when ERC1271_ENABLED is on, and only after ECDSA does not match.
 */
export async function assertIntentSigner(intent, config, chain) {
  const typed = typedDataFor(intent, config);
  let recovered = null;
  try {
    recovered = await recoverTypedDataAddress({ ...typed, signature: intent.signature });
  } catch {
    recovered = null;
  }
  if (recovered && sameAddress(recovered, intent.sender)) return;
  if (!config.erc1271Enabled) throw httpError(401, "invalid_signature");
  if (!chain || typeof chain.isValidSignature !== "function") throw httpError(401, "invalid_signature");
  const magic = await chain.isValidSignature(intent.sender, typed, intent.signature);
  if (magic !== true) throw httpError(401, "invalid_signature");
}

/**
 * Step 5. keccak256(calldata) matches the signed hash, and the selector is allowlisted
 * for the signed action.
 */
export function assertCalldataBinding(intent) {
  let digest;
  try {
    digest = keccak256(hexToBytes(intent.calldata));
  } catch {
    throw httpError(400, "invalid_calldata");
  }
  if (digest.toLowerCase() !== intent.calldataHash) throw httpError(400, "calldata_hash_mismatch");
  const selector = intent.calldata.slice(0, 10).toLowerCase();
  const allowed = SELECTOR_ACTION.get(selector);
  if (!allowed) throw httpError(400, "selector_not_allowed", { selector });
  if (allowed !== intent.action) throw httpError(400, "selector_not_allowed", { selector });
  return { selector, action: allowed };
}

export function nonceKey(sender, nonce) {
  return `${getAddress(sender).toLowerCase()}:${nonce.toString()}`;
}

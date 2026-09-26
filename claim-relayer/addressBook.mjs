import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** deployments/base-sepolia.json next to this package. */
export const DEFAULT_ADDRESS_BOOK = fileURLToPath(
  new URL("../deployments/base-sepolia.json", import.meta.url),
);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BASE_SEPOLIA_CHAIN_ID = 84532;

function bookError(error, extra = {}) {
  return Object.assign(new Error(error), { status: 500, error, ...extra });
}

function optionalAddress(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ADDRESS_RE.test(trimmed) || trimmed.toLowerCase() === ZERO_ADDRESS) return null;
  return trimmed;
}

/** Deploy block used as the indexer/relayer start block. Missing or invalid is null. */
function optionalStartBlock(slot) {
  const raw = slot.deployBlock ?? slot.startBlock;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Read the committed Base Sepolia address book.
 * A null Escrow slot is unbooked. A non-address is refused.
 * Mainnet books are refused. This does not query a chain.
 */
export function loadAddressBook(filePath = DEFAULT_ADDRESS_BOOK) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw bookError("address_book_unreadable");
  }
  const chainId = Number(raw.chainId);
  if (chainId === 1 || chainId === 8453) {
    throw bookError("mainnet_refused", { chainId });
  }
  if (chainId !== BASE_SEPOLIA_CHAIN_ID || raw.network !== "base-sepolia") {
    throw bookError("wrong_chain", { chainId: raw.chainId });
  }

  const slot = raw.BotAttestationEscrow && typeof raw.BotAttestationEscrow === "object" ? raw.BotAttestationEscrow : {};
  const rawEscrow = slot.address;
  let escrowAddress = null;
  if (rawEscrow !== null && rawEscrow !== undefined && String(rawEscrow).trim() !== "") {
    escrowAddress = optionalAddress(rawEscrow);
    if (!escrowAddress) throw bookError("invalid_escrow_address");
  }

  const bvtRaw = raw.BVT && typeof raw.BVT === "object" ? raw.BVT.address : null;
  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    network: "base-sepolia",
    escrowAddress,
    escrowBooked: Boolean(escrowAddress),
    escrowStartBlock: optionalStartBlock(slot),
    escrowOwner: optionalAddress(slot.owner),
    disputePanelAddress: optionalAddress(raw.DisputePanel?.address),
    coreTimelock: optionalAddress(raw.coreTimelock),
    bvtAddress: bvtRaw === null || bvtRaw === undefined || String(bvtRaw).trim() === "" ? null : optionalAddress(bvtRaw),
  };
}

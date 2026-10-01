import { decodeEventLog, encodeAbiParameters, encodeEventTopics, keccak256, toBytes } from "viem";
import { assertDenylistBucket } from "../denylistBucket.mjs";

/**
 * Business and signal events. topic0 is keccak256 of the canonical signature.
 * Governance-only topics (ownership, retired 1-field and live 4-field VaultUpdated) are ignored.
 * Indexed flags match contracts/Vault.sol, BotAttestationEscrow.sol, DisputePanel.sol, Denylist.sol
 * and docs/reputation/EVENT_MAP.md in PR #28.
 */
export const BUSINESS_EVENTS = [
  {
    name: "Registered",
    contract: "vault",
    signature: "Registered(bytes32,uint8,uint256)",
    item: {
      type: "event",
      name: "Registered",
      inputs: [
        { name: "botId", type: "bytes32", indexed: true },
        { name: "tier", type: "uint8", indexed: false },
        { name: "ts", type: "uint256", indexed: false },
      ],
    },
  },
  {
    name: "OperatorSet",
    contract: "vault",
    signature: "OperatorSet(bytes32,address)",
    item: {
      type: "event",
      name: "OperatorSet",
      inputs: [
        { name: "botId", type: "bytes32", indexed: true },
        { name: "account", type: "address", indexed: true },
      ],
    },
  },
  {
    name: "Burned",
    contract: "vault",
    signature: "Burned(bytes32,uint256)",
    item: {
      type: "event",
      name: "Burned",
      inputs: [
        { name: "botId", type: "bytes32", indexed: true },
        { name: "ts", type: "uint256", indexed: false },
      ],
    },
  },
  {
    name: "EscrowCreated",
    contract: "escrow",
    signature: "EscrowCreated(bytes32,address,address,bytes32,bytes32,uint256,uint256)",
    item: {
      type: "event",
      name: "EscrowCreated",
      inputs: [
        { name: "escrowId", type: "bytes32", indexed: true },
        { name: "payer", type: "address", indexed: true },
        { name: "payee", type: "address", indexed: true },
        { name: "payerBotId", type: "bytes32", indexed: false },
        { name: "payeeBotId", type: "bytes32", indexed: false },
        { name: "amount", type: "uint256", indexed: false },
        { name: "expiresAt", type: "uint256", indexed: false },
      ],
    },
  },
  {
    name: "EscrowReleased",
    contract: "escrow",
    signature: "EscrowReleased(bytes32,uint256)",
    item: {
      type: "event",
      name: "EscrowReleased",
      inputs: [
        { name: "escrowId", type: "bytes32", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
  },
  {
    name: "EscrowRefunded",
    contract: "escrow",
    signature: "EscrowRefunded(bytes32,uint256)",
    item: {
      type: "event",
      name: "EscrowRefunded",
      inputs: [
        { name: "escrowId", type: "bytes32", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
      ],
    },
  },
  {
    name: "EscrowDisputed",
    contract: "escrow",
    signature: "EscrowDisputed(bytes32,bytes32)",
    item: {
      type: "event",
      name: "EscrowDisputed",
      inputs: [
        { name: "escrowId", type: "bytes32", indexed: true },
        { name: "disputeId", type: "bytes32", indexed: false },
      ],
    },
  },
  {
    name: "DisputeOpened",
    contract: "dispute_panel",
    signature: "DisputeOpened(bytes32,bytes32,address)",
    item: {
      type: "event",
      name: "DisputeOpened",
      inputs: [
        { name: "disputeId", type: "bytes32", indexed: true },
        { name: "subjectHash", type: "bytes32", indexed: true },
        { name: "challenger", type: "address", indexed: false },
      ],
    },
  },
  {
    name: "VoteCast",
    contract: "dispute_panel",
    signature: "VoteCast(bytes32,address,bool)",
    item: {
      type: "event",
      name: "VoteCast",
      inputs: [
        { name: "disputeId", type: "bytes32", indexed: true },
        { name: "voter", type: "address", indexed: false },
        { name: "support", type: "bool", indexed: false },
      ],
    },
  },
  {
    name: "DisputeResolved",
    contract: "dispute_panel",
    signature: "DisputeResolved(bytes32,bool)",
    item: {
      type: "event",
      name: "DisputeResolved",
      inputs: [
        { name: "disputeId", type: "bytes32", indexed: true },
        { name: "upheld", type: "bool", indexed: false },
      ],
    },
  },
  {
    name: "Listed",
    contract: "denylist",
    signature: "Listed(bytes32,uint8,address,uint256,uint64)",
    item: {
      type: "event",
      name: "Listed",
      inputs: [
        { name: "id", type: "bytes32", indexed: true },
        { name: "bucket", type: "uint8", indexed: true },
        { name: "actor", type: "address", indexed: true },
        { name: "timestamp", type: "uint256", indexed: false },
        { name: "timesListed", type: "uint64", indexed: false },
      ],
    },
  },
  {
    name: "Unlisted",
    contract: "denylist",
    signature: "Unlisted(bytes32,uint8,address,uint256,uint64)",
    item: {
      type: "event",
      name: "Unlisted",
      inputs: [
        { name: "id", type: "bytes32", indexed: true },
        { name: "bucket", type: "uint8", indexed: true },
        { name: "actor", type: "address", indexed: true },
        { name: "timestamp", type: "uint256", indexed: false },
        { name: "timesListed", type: "uint64", indexed: false },
      ],
    },
  },
];

export const EVENT_ABI = BUSINESS_EVENTS.map((event) => event.item);

const BY_TOPIC = new Map();
const BY_NAME = new Map();
for (const event of BUSINESS_EVENTS) {
  const topic0 = keccak256(toBytes(event.signature));
  event.topic0 = topic0;
  BY_TOPIC.set(topic0, event);
  BY_NAME.set(event.name, event);
}

export function eventByName(name) {
  return BY_NAME.get(name) || null;
}

export function eventByTopic(topic0) {
  return BY_TOPIC.get(String(topic0 || "").toLowerCase()) || null;
}

export function topic0Table() {
  return BUSINESS_EVENTS.map((event) => ({
    name: event.name,
    signature: event.signature,
    topic0: event.topic0,
    contract: event.contract,
  }));
}

/** Encode a fixture log body (topics + data) from named args. */
export function encodeEventData(eventName, args) {
  const event = BY_NAME.get(eventName);
  if (!event) throw new Error(`unknown_event:${eventName}`);
  if (event.name === "Listed" || event.name === "Unlisted") {
    assertDenylistBucket(args?.bucket);
  }
  const topics = encodeEventTopics({
    abi: [event.item],
    eventName: event.name,
    args,
  });
  const nonIndexed = event.item.inputs.filter((input) => !input.indexed);
  const data =
    nonIndexed.length === 0 ? "0x" : encodeAbiParameters(nonIndexed, nonIndexed.map((input) => args[input.name]));
  return { topics, data };
}

/**
 * Decode one log. Returns null when the topic is not a business or signal event.
 * Throws when the topic matches and the payload does not decode.
 */
export function decodeBusinessLog(log) {
  const topic0 = log.topics && log.topics[0] ? String(log.topics[0]).toLowerCase() : "";
  const event = BY_TOPIC.get(topic0);
  if (!event) return null;
  let decoded;
  try {
    decoded = decodeEventLog({
      abi: EVENT_ABI,
      data: log.data || "0x",
      topics: log.topics,
    });
  } catch {
    const err = new Error("log_decode_failed");
    err.error = "log_decode_failed";
    err.status = 400;
    err.event = event.name;
    throw err;
  }
  return { name: event.name, contract: event.contract, args: decoded.args };
}

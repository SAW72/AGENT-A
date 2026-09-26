import { getAddress } from "viem";
import { encodeEventData } from "../reputation/codec.mjs";

export const VAULT = "0x1463D664fA467FBCDA4B05443434494f05e565bc";
export const ESCROW = "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c";
export const PANEL = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb";
export const DENYLIST = "0xeE76876bECcFc1B58fC06fF4E654a517d784B224";

/** First second of a UTC day, so day math does not depend on the local zone. */
export const DAY0 = 1_699_920_000;
export const BLOCK0 = 48_000_000;
export const FLOOR = 100_000_000_000_000n;

export function bytes32(n) {
  return `0x${BigInt(n).toString(16).padStart(64, "0")}`;
}

export function addr(byte) {
  return getAddress(`0x${byte.toString(16).padStart(2, "0").repeat(20)}`);
}

export function dayTs(day, offset = 0) {
  return DAY0 + day * 86400 + offset;
}

let seq = 1;

export function businessLog({
  event,
  args,
  address,
  blockNumber,
  logIndex = 0,
  timestamp,
  tx,
  blockHash,
  removed = false,
  chainId,
}) {
  seq += 1;
  const encoded = encodeEventData(event, args);
  return {
    address,
    ...encoded,
    blockNumber,
    logIndex,
    blockTimestamp: timestamp,
    transactionHash: tx || bytes32(0x5000 + seq),
    blockHash: blockHash || bytes32(0x6000n + BigInt(blockNumber) * 16n + BigInt(logIndex)),
    removed,
    ...(chainId !== undefined ? { chainId } : {}),
  };
}

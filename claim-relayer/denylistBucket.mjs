/**
 * Denylist.Bucket ordinals. Exact = 0, Signature = 1, Prompt = 2.
 * Until L-4 ships, the live Sepolia Denylist maps any other uint8 onto Prompt
 * instead of reverting. This helper does not. Call it before encoding a bucket,
 * and use it when a decoded bucket is applied.
 */

export const DENYLIST_BUCKET = Object.freeze({
  Exact: 0,
  Signature: 1,
  Prompt: 2,
});

const NAME_BY_VALUE = new Map([
  [0, "Exact"],
  [1, "Signature"],
  [2, "Prompt"],
]);

/** Integer 0–255, or null when the value is not a uint8. Does not alias unknowns to Prompt. */
export function denylistBucketOrdinal(value) {
  let ordinal = value;
  if (typeof ordinal === "bigint") {
    if (ordinal < 0n || ordinal > 255n) return null;
    ordinal = Number(ordinal);
  } else if (typeof ordinal === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(ordinal)) return null;
    ordinal = Number(ordinal);
  }
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 255) return null;
  return ordinal;
}

/** "Exact", "Signature", or "Prompt". Null for every other value, including values the live contract would store as Prompt. */
export function denylistBucketName(value) {
  const ordinal = denylistBucketOrdinal(value);
  if (ordinal === null) return null;
  return NAME_BY_VALUE.get(ordinal) ?? null;
}

export function isValidDenylistBucket(value) {
  return denylistBucketName(value) !== null;
}

/**
 * Accept only Exact, Signature, and Prompt.
 * Throws invalid_bucket. Callers must do this before encoding calldata or event topics.
 */
export function assertDenylistBucket(value) {
  const ordinal = denylistBucketOrdinal(value);
  const name = ordinal === null ? null : NAME_BY_VALUE.get(ordinal) ?? null;
  if (name === null) {
    const err = new Error("invalid_bucket");
    err.error = "invalid_bucket";
    err.status = 400;
    err.bucket = value;
    throw err;
  }
  return { value: ordinal, name };
}

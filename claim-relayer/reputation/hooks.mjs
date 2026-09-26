/**
 * Checklist #7 and #9. Defaults fail closed: nothing is silently credited.
 * PR #28's indexer stub returns eligible:true for staging. This service does not.
 * See docs/reputation-ledger.md.
 */

export function createDefaultEligibility() {
  return function screen() {
    return {
      eligible: false,
      status: "unverified",
      points_withheld: true,
      reason: "ofac_unconfigured",
      provider: null,
    };
  };
}

export function createDefaultEnforcer() {
  const flags = [];
  return {
    flag(signal) {
      flags.push(signal);
      if (signal.kind === "O5_REPEAT") {
        return { withhold_wallet: true, reason: "abuse_policy_unconfigured" };
      }
      return { withhold_wallet: false, reason: "enforcer_unconfigured" };
    },
    flags() {
      return flags;
    },
  };
}

export function createDefaultHooks() {
  return {
    eligibility: createDefaultEligibility(),
    enforcer: createDefaultEnforcer(),
  };
}

/** Test and staging override. Credits are still cap-limited. */
export function allowAllEligibility() {
  return function screen() {
    return { eligible: true, status: "eligible", points_withheld: false, reason: null, provider: "allow_all" };
  };
}

export function recordingEnforcer({ withholdOn = [] } = {}) {
  const kinds = new Set(withholdOn);
  const flags = [];
  return {
    flag(signal) {
      flags.push(signal);
      const withhold = kinds.has(signal.kind);
      return { withhold_wallet: withhold, reason: withhold ? signal.kind : null };
    },
    flags() {
      return flags;
    },
  };
}

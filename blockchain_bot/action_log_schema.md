# On-Chain Action Log Schema

Every action a policy-enforced bot takes is recorded immutably. This is the bot's perfect history.

## Log entry (per action)
```
{
  "proposalId": "0x...",          // unique id for this proposal
  "botAddress": "0x...",         // the bot's on-chain identity
  "timestamp": 1710000000,       // block timestamp
  "blockNumber": 12345678,
  "actionType": "transfer | swap | approve | custom",
  "target": "0x...",             // counterparty or contract called
  "amount": "1000000000000000000",  // in wei or token units
  "status": "proposed | approved | executed | rejected",
  "reason": "within limits" | "exceeds daily limit" | ...,
  "policyHash": "0x...",         // hash of the policy in force at the time
  "brainHash": "0x..."           // optional: hash of the off-chain reasoning trace
}
```

## What this gives the verifier
- A complete, tamper-evident timeline of every action.
- No gaps — every proposal is logged, whether approved or rejected.
- Policy version is recorded, so you can see when rules changed.
- Optional link to the off-chain reasoning (brainHash) so you can audit *why* the bot proposed something, not just what it did.

## Query patterns
- All actions by a bot in a date range.
- All rejections (these are the near-misses — gold for the verifier).
- All actions above a threshold.
- Actions targeting a specific counterparty.
- Drift: compare action patterns before and after a policy update.

## Integration with Agent A (Agent Auditor)
The `background/` incident log and the `chain/` attestation both read from this log. The on-chain action log is the source of truth; the off-chain reports are derived from it.

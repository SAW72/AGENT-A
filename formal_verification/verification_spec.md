# Verification Spec

## Tools
- Slither for static analysis
- Certora or equivalent for formal property verification
- Foundry for fuzzing

## Commands
```bash
# Static analysis
slither contracts/Denylist.sol
slither contracts/Vault.sol

# Fuzzing
forge test --fuzz-runs 10000

# Formal verification (Certora example)
certoraRun contracts/Denylist.sol --verify Denylist:specs/denylist.spec
```

## CI Integration
See `ci_verification.yml`. Runs on every push to main and every PR touching `contracts/`.

## Tip properties the Foundry suite must keep green
These match `invariants.md` and the live Denylist and Vault source. They are not a Certora proof.

- `remove` leaves `everListed` and `timesListed` in place.
- `PromptBlock` is a hard block (`MatchLevel` ordinal 1).
- `Vault.register` reverts unless `denylist.check` returns `None`.
- `Denylist.check` records no logs. There is no `Checked` event.
- Registering with an operator stores that operator. A still-listed fingerprint blocks `register`.

```bash
forge test --match-contract 'DenylistTest|VaultTest|OpsLiveGuardTest'
```

## Pass Criteria
- Zero critical or high findings from Slither
- All invariants hold under fuzzing
- Formal verification completes with no counterexamples
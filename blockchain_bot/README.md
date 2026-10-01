# Blockchain-Enforced Bot (Policy-Enforced Bot)

The pattern for bots that must be accountable on-chain — especially financial or high-stakes bots.

## Core idea
You cannot put the model weights on-chain. They are too large and inference is too slow.

Instead you split the bot:
- **Brain** (off-chain): the LLM, reasoning, weights, system prompt. Runs wherever it is fast.
- **Hands** (on-chain): every action the bot takes must pass through a smart contract. No contract approval, no action.

The bot can *want* whatever it wants. It can only *do* what the rules permit.

## Why this matters for the verifier
- Every action is logged, timestamped, and immutable.
- You get a perfect incident log for free — no deleted history, no reinvented past.
- The chain remembers everything the bot did, even if the bot itself forgets.
- You are not verifying the bot's soul. You are verifying its leash. A bot built this way can still be deceptive in its reasoning — it just cannot act on the deception without the contract catching it.

## Architecture
```
[ User / Trigger ]
        |
        v
[ Bot Brain (off-chain LLM) ]  --> proposes an action
        |
        v
[ Policy Contract (on-chain) ]  --> checks rules
        |
   approved? --no--> reject + log
        |
       yes
        v
[ Execute action ]  --> emit event + log on-chain
```

## Rules the contract enforces (examples)
- Transaction limits (max amount per action, per day, per counterparty)
- Approved counterparties only
- Time windows (no actions outside business hours)
- Escalation thresholds (actions above X require human co-sign)
- Rate limits (max N actions per hour)
- Whitelisted functions only (no arbitrary calls)

## Files in this folder
- `policy_contract.md` — the smart contract design and rules schema
- `action_log_schema.md` — what gets recorded on every on-chain action
- `brain_hands_split.md` — how to wire the off-chain brain to the on-chain hands
- `verifier_integration.md` — how Agent A (Agent Auditor) reads the on-chain action log
- `example_policy.sol` — a minimal Solidity example (stub)

## Quick start
1. Define your policy rules in `policy_contract.md`.
2. Deploy the contract on Base (or your chain).
3. Wire the bot brain to call `proposeAction()` instead of executing directly.
4. Run the verifier against the on-chain action log — it is now a perfect, tamper-evident history.

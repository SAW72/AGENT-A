# Cross-Chain Layer

This folder holds the design for making Agent A (Agent Auditor) work independently across every blockchain.

## Files
- `hub_spoke_architecture.md` — the canonical hub with decentralized validators, light-client spokes on every chain.
- `local_cache_for_trading.md` — how high-frequency trading bots avoid round-trip latency using signed allowlists and heartbeats.
- `bridge_design.md` — permissionless bridge for upward and downward record flow.
- `light_client_notes.md` — how spokes verify hub state without trusting a relayer.
- `portable_fingerprint.md` — chain-agnostic fingerprint format.
- `cross_chain_bot_prompt.md` — prompt for the cross-chain monitor bot.

## Principle
One protocol, every chain, no single point of control. Trading bots get speed through cached attestations; safety comes from fail-closed expiry.

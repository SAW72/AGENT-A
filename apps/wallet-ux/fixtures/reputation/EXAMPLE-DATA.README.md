# EXAMPLE DATA reputation responses

These files are copies of the claim-relayer example responses for wallet-ux tests and the dev harness. They are **EXAMPLE DATA**, not a live Base Sepolia scan. The JSON bodies are unchanged from `claim-relayer/fixtures/reputation/` on draft PR #29. Filenames are prefixed `EXAMPLE-DATA` so the copy is obvious.

The usage ledger id is `agent-bv-sepolia-reputation`. The arbitrator ledger id is `agent-bv-sepolia-arbitrator-rep`. The config example's `product` and `product_title` are copied from `product.name` and `product.title` through the handler.

| File | Request |
| --- | --- |
| `EXAMPLE-DATA.balance.example.json` | `GET /v1/reputation/{address}?chainId=84532` |
| `EXAMPLE-DATA.history.example.json` | `GET /v1/reputation/{address}/history?chainId=84532&ledger=usage&limit=25` |
| `EXAMPLE-DATA.config.example.json` | `GET /v1/reputation/config?chainId=84532` |

The `response` object is the HTTP body. Eligibility is `unverified` and points are withheld, which is the default while checklist #7 is open. Caps in the config example are `draft` while checklist #12 is open. Disclaimer link slots are `null` while checklist #11 is open.

The history example is the usage ledger only. `next_cursor` is null. The usage and arbitrator ledgers are separate objects. Nothing in these files is a combined total.

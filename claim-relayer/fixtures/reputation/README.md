# Example reputation responses

These files are **example data** for the reputation read API. They are fixture output, not a live Base Sepolia scan, and the contracts have not emitted these logs. The usage ledger id is `agent-bv-sepolia-reputation`. The arbitrator ledger id is `agent-bv-sepolia-arbitrator-rep`. The config example's `product` and `product_title` are copied from `product.name` and `product.title` in `config/reputation/sepolia.json` through the handler. That object is the only authored copy.

| File | Request |
| --- | --- |
| `balance.example.json` | `GET /v1/reputation/{address}?chainId=84532` |
| `history.example.json` | `GET /v1/reputation/{address}/history?chainId=84532&ledger=usage&limit=25` |
| `config.example.json` | `GET /v1/reputation/config?chainId=84532` |

The `response` object is the HTTP body. Eligibility is `unverified` and points are withheld, which is the default while checklist #7 is open. Caps in the config example are `draft` while checklist #12 is open. Disclaimer link slots are `null` while checklist #11 is open.

The usage and arbitrator ledgers are separate objects. Nothing in these files is a combined total.

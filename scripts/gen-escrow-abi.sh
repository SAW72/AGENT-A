#!/usr/bin/env bash
# Regenerate the wallet-ux BotAttestationEscrow ABI from the forge build artifact.
# Source: out/BotAttestationEscrow.sol/BotAttestationEscrow.json (.abi)
# Contract: contracts/BotAttestationEscrow.sol:BotAttestationEscrow
#
# Run `forge build` first. Entries are sorted by kind, name, and input types,
# then written as stable 2-space JSON. CI fails if the committed file differs.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
artifact="$root/out/BotAttestationEscrow.sol/BotAttestationEscrow.json"
dest="$root/apps/wallet-ux/src/abi/BotAttestationEscrow.json"

if [[ ! -f "$artifact" ]]; then
  echo "Missing forge artifact: $artifact" >&2
  echo "Run: forge build && ./scripts/gen-escrow-abi.sh" >&2
  exit 1
fi

python3 - "$artifact" "$dest" << 'PY'
import json
import sys
from pathlib import Path

artifact, dest = sys.argv[1], sys.argv[2]
data = json.loads(Path(artifact).read_text())
abi = data.get("abi")
if not isinstance(abi, list):
    raise SystemExit(f"Forge artifact has no abi array: {artifact}")

# constructor, receive, fallback, function, event, error — then name, then inputs.
rank = {
    "constructor": 0,
    "receive": 1,
    "fallback": 2,
    "function": 3,
    "event": 4,
    "error": 5,
}

def sort_key(item: dict) -> tuple:
    inputs = ",".join(arg.get("type", "") for arg in item.get("inputs") or [])
    return (rank.get(item.get("type"), 9), item.get("name") or "", inputs)

abi.sort(key=sort_key)
Path(dest).write_text(json.dumps(abi, indent=2) + "\n")
print(f"Wrote {dest} ({len(abi)} ABI entries)")
PY

# Checks the paste-safe operator guard in docs/runbooks/register-test-bots-base-sepolia.md.
# Run with bash and with zsh. A failing guard returns 1; this script keeps going and
# exits 1 at the end if any case missed. It does not broadcast.

fail=0
if [ -n "${ZSH_VERSION-}" ]; then
  shell=zsh
elif [ -n "${BASH_VERSION-}" ]; then
  shell=bash
else
  shell="sh"
fi

root=$(cd -- "$(dirname "$0")/.." && pwd)
md=$root/docs/runbooks/register-test-bots-base-sepolia.md

extract() {
  n=$1
  awk -v n="$n" '
    /^ops_guard\(\) \{/ { c++; g=1 }
    g && c==n { print }
    g && c==n && /^}$/ { g=0 }
  ' "$md"
}

a=$(extract 1)
b=$(extract 2)
c=$(extract 3)
if [ -z "$a" ] || [ "$a" != "$b" ] || [ "$a" != "$c" ]; then
  echo "$shell: the three ops_guard copies differ or are missing"
  exit 1
fi

unset_count=$(grep -c '^unset PAYER_OPERATOR PAYEE_OPERATOR$' "$md" || true)
if [ "$unset_count" != 1 ]; then
  echo "$shell: expected one standalone unset line, found $unset_count"
  fail=$((fail + 1))
fi
export_has_unset=$(awk '
  /^## Checklist$/ { p=1 }
  p && /^```bash$/ { f=1; next }
  f && /^```$/ { exit }
  f && /^unset / { print "yes"; exit }
' "$md")
if [ "$export_has_unset" = yes ]; then
  echo "$shell: the export block still contains unset"
  fail=$((fail + 1))
fi

# shellcheck disable=SC1090
eval "$a"

GOOD_PAYER=0xAbcAbC0000000000000000000000000000000001
GOOD_PAYEE=0xabCAbc0000000000000000000000000000000002
RELAYER=0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861
LIVE=0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d
RETIRED=0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c
TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9

check() {
  label=$1
  want=$2
  needle=$3
  PAYER_OPERATOR=$4
  PAYEE_OPERATOR=$5
  export PAYER_OPERATOR PAYEE_OPERATOR
  out=$(ops_guard 2>&1)
  got=$?
  printf '== %s %s ==\n' "$shell" "$label"
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
  fi
  printf 'rc %s (want %s)\n' "$got" "$want"
  if [ "$got" != "$want" ]; then
    echo MISMATCH
    fail=$((fail + 1))
  fi
  if [ -n "$needle" ]; then
    case $out in
      *"$needle"*) ;;
      *)
        echo "MISSING: $needle"
        fail=$((fail + 1))
        ;;
    esac
  elif [ -n "$out" ]; then
    echo "UNEXPECTED OUTPUT"
    fail=$((fail + 1))
  fi
}

check "good pair" 0 "" "$GOOD_PAYER" "$GOOD_PAYEE"
check "stale stand-ins without unset" 1 "PAYER_OPERATOR is a known sample or stale address" \
  0x1111111111111111111111111111111111111111 \
  0x2222222222222222222222222222222222222222
check "payee stand-in" 1 "PAYEE_OPERATOR is a known sample or stale address" \
  "$GOOD_PAYER" 0x2222222222222222222222222222222222222222
check "payee bEEF" 1 "PAYEE_OPERATOR is a known sample or stale address" \
  "$GOOD_PAYER" 0x000000000000000000000000000000000000bEEF
check "payee bEEF lowercase" 1 "PAYEE_OPERATOR is a known sample or stale address" \
  "$GOOD_PAYER" 0x000000000000000000000000000000000000beef
check "payee zero" 1 "PAYEE_OPERATOR is a known sample or stale address" \
  "$GOOD_PAYER" 0x0000000000000000000000000000000000000000
check "payer equals payee" 1 "PAYEE_OPERATOR invalid/placeholder" "$GOOD_PAYER" "$GOOD_PAYER"
check "payer relayer" 1 "PAYER_OPERATOR is the relayer" "$RELAYER" "$GOOD_PAYEE"
check "payer relayer lowercase" 1 "PAYER_OPERATOR is the relayer" \
  0x9d1b3e1400d2632d435cb7c0fc131c4f42b31861 "$GOOD_PAYEE"
check "payee relayer" 1 "PAYEE_OPERATOR is the relayer" "$GOOD_PAYER" "$RELAYER"
check "payee relayer lowercase" 1 "PAYEE_OPERATOR is the relayer" \
  "$GOOD_PAYER" 0x9d1b3e1400d2632d435cb7c0fc131c4f42b31861
check "payer live escrow" 1 "PAYER_OPERATOR is a known sample or stale address" "$LIVE" "$GOOD_PAYEE"
check "payee live escrow lowercase" 1 "PAYEE_OPERATOR is a known sample or stale address" \
  "$GOOD_PAYER" 0x1069aa6597f08f1e8b8ad39aa40ede1d0c77298d
check "payer retired escrow" 1 "PAYER_OPERATOR is a known sample or stale address" "$RETIRED" "$GOOD_PAYEE"
check "payee retired escrow lowercase" 1 "PAYEE_OPERATOR is a known sample or stale address" \
  "$GOOD_PAYER" 0x141214f04b0e1d949b6e6bf32d019ad7ab5b284c
check "payer simulate sender" 1 "PAYER_OPERATOR is a known sample or stale address" \
  0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001 "$GOOD_PAYEE"
check "payee foundry sender" 1 "PAYEE_OPERATOR is a known sample or stale address" \
  "$GOOD_PAYER" 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38
check "payer sample arbitrator" 1 "PAYER_OPERATOR is a known sample or stale address" \
  0x0000000000000000000000000000000000000A11 "$GOOD_PAYEE"
check "payee sample from-address" 1 "PAYEE_OPERATOR is a known sample or stale address" \
  "$GOOD_PAYER" 0x0000000000000000000000000000000000000001
check "quoted placeholders" 1 "PAYER_OPERATOR invalid/placeholder" \
  "<SPENCER_PAYER_WALLET>" "<REAL_PAYEE_WALLET>"
check "timelock payer still allowed" 0 "" "$TIMELOCK" "$GOOD_PAYEE"

# Stale values stay set until something clears them. The guard fails without unset.
PAYER_OPERATOR=0x1111111111111111111111111111111111111111
PAYEE_OPERATOR=0x2222222222222222222222222222222222222222
export PAYER_OPERATOR PAYEE_OPERATOR
out=$(ops_guard 2>&1)
got=$?
printf '== %s stale pair still set ==\n%s\nrc %s\n' "$shell" "$out" "$got"
if [ "$got" != 1 ]; then
  echo MISMATCH
  fail=$((fail + 1))
fi
unset PAYER_OPERATOR PAYEE_OPERATOR
out=$(ops_guard 2>&1)
got=$?
printf '== %s after standalone unset ==\n%s\nrc %s\n' "$shell" "$out" "$got"
if [ "$got" != 1 ]; then
  echo MISMATCH
  fail=$((fail + 1))
fi
case $out in
  *"PAYER_OPERATOR invalid/placeholder"*) ;;
  *)
    echo "MISSING: PAYER_OPERATOR invalid/placeholder"
    fail=$((fail + 1))
    ;;
esac

echo "SHELL-ALIVE $shell fail=$fail"
if [ "$fail" != 0 ]; then
  exit 1
fi
echo "ALL PASS ($shell)"

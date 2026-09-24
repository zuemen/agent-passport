#!/usr/bin/env bash
# Mutation check: each mutant below removes one rule from the contracts, in a scratch copy of contracts/, and
# the tests named next to it must then fail. This directory is never modified.
#
#   bash script/mutants.sh            from contracts/ (needs forge and perl; a few minutes — the invariants run)
#
# Exits non-zero if a mutant survives (its tests still pass) or does not compile.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -r "$here/src" "$here/test" "$here/script" "$here/foundry.toml" "$work/"
mkdir -p "$work/lib/forge-std" "$work/lib/openzeppelin-contracts"
cp -r "$here/lib/forge-std/src" "$work/lib/forge-std/"
cp -r "$here/lib/openzeppelin-contracts/contracts" "$work/lib/openzeppelin-contracts/"

G=src/PassportGate.sol
F=src/GroundedFeedback.sol
# file | original line (exact text) | mutant | tests that must fail | what the mutant breaks
mutants=(
  "$G|if (status != CredentialStatusRegistry.Status.Active) return _statusReason(status);|// mutant|invariant_neverAuthorizedAfterRevocation|revoked or expired mandates still pass"
  "$G|nonceUsed[agentWallet][intent.nonce] = true;|// mutant|invariant_noIntentAuthorizedTwice|an authorized intent can be replayed"
  "$G|if (spent[p.credentialId][asset][_today()] + amount > uint256(p.dailyLimit.value)) {|if (false) {|invariant_spendWithinLimits|no daily limit"
  "$G|if (amount > uint256(p.maxPerTx.value)) return Reason.ExceedsPerTxLimit;|// mutant|test_revert_exceedsPerTx|no per-transaction limit"
  "$G|if (p.scope.value != scope) return Reason.ScopeNotGranted;|// mutant|test_check_scopeNotGranted|any scope accepted"
  "$G|if (p.payee.key != PassportClaims.payeeKey(relyingParty) \|\| p.payee.value != PassportClaims.ALLOWED) {|if (false) {|test_revert_payeeNotAllowed|any counterparty accepted"
  "$G|return MerkleProof.verifyCalldata(d.proof, root, PassportClaims.leaf(d.salt, d.key, d.value));|return true;|test_check_tamperedDisclosure|disclosed claims not proven"
  "$G|if (agentWallet == address(0) \|\| !SignatureChecker.isValidSignatureNow(agentWallet, actionId, agentSignature)) {|if (agentWallet == address(0)) {|test_revert_signatureFromWrongKey|the agent's signature not checked"
  "$G|if (msg.sender != intent.relyingParty) revert WrongRelyingParty();|// mutant|test_revert_wrongRelyingParty|another contract can use the intent"
  "$G|requiresVlei[relyingParty][scope]|false|test_vlei_requiredScope_rejectsUnverifiedOwner|vLEI requirement ignored"
  "$F|if (a.relyingParty != msg.sender) revert NotCounterparty();|// mutant|test_groundedFeedback_reverts|anyone can rate an action"
  "$F|if (rated[actionId]) revert AlreadyRated();|// mutant|test_groundedFeedback_reverts|an action can be rated twice"
)

# \| in the table is a literal |; split on unescaped | only.
split() { perl -e '@f = split /(?<!\\)\|/, $ARGV[0]; s/\\\|/|/g for @f; print join("\0", @f)' "$1"; }
echo "▸ baseline: compiling the scratch copy and running every named test unmutated"
killers="$(for m in "${mutants[@]}"; do split "$m" | tr '\0' '\n' | sed -n 4p; done | sort -u | paste -sd'|' -)"
if ! forge test --root "$work" --match-test "$killers" > "$work/baseline.log" 2>&1; then
  tail -30 "$work/baseline.log"
  echo "✗ the named tests do not pass unmutated"
  exit 1
fi

# Apply one mutant, run its tests, restore the file. Prints passed / failed / error (did not compile or run).
try() {
  local file="$1" from="$2" to="$3" tests="$4"
  cp "$work/$file" "$work/$file.orig"
  FROM="$from" TO="$to" perl -0pi -e '
    my $n = () = /\Q$ENV{FROM}\E/g;
    die "expected one match, found $n\n" unless $n == 1;
    s/\Q$ENV{FROM}\E/$ENV{TO}/;
  ' "$work/$file" >&2 || { mv "$work/$file.orig" "$work/$file"; echo error; return; }
  if forge test --root "$work" --match-test "$tests" > "$work/run.log" 2>&1; then
    if grep -q "\[PASS" "$work/run.log"; then echo passed; else echo error; fi
  elif grep -q "\[FAIL" "$work/run.log"; then
    echo failed
  else
    echo error
  fi
  mv "$work/$file.orig" "$work/$file"
}

failed=0
printf '\n%-44s %-48s %s\n' "mutant" "must fail" "result"
for m in "${mutants[@]}"; do
  IFS=$'\n' read -r -d '' file from to tests what < <(split "$m" | tr '\0' '\n'; printf '\0') || true
  case "$(try "$file" "$from" "$to" "$tests")" in
    failed) result="killed" ;;
    passed) result="SURVIVED"; failed=1 ;;
    *) result="ERROR"; failed=1; tail -20 "$work/run.log" ;;
  esac
  printf '%-44s %-48s %s\n' "$what" "$tests" "$result"
done

# Control: a rewrite that keeps the meaning must survive, or the harness would call anything "killed".
control="$(try "$G" "return block.timestamp / 1 days;" "return (block.timestamp + 0) / 1 days;" "test_revert_exceedsDaily_thenResetsNextDay")"
if [ "$control" = passed ]; then result="survived, as it should"; else result="CONTROL $control"; failed=1; fi
printf '%-44s %-48s %s\n' "control: same meaning, rewritten" "test_revert_exceedsDaily_thenResetsNextDay" "$result"

if [ "$failed" -ne 0 ]; then
  echo "✗ a mutant survived or did not compile"
  exit 1
fi
echo "✓ every mutant was killed"

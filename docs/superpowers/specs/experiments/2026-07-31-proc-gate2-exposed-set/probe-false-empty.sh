#!/bin/sh
# A THIRD trap that produces a false PASS — this one in the instrument, not the
# setup. The other two are recorded in the spec (§3's `dumpable` trap, C1's
# surviving-launcher trap); this one matters because the tripwire §5 asks for is
# an assertion that a probe finds NOTHING, and the natural way to write that
# probe reads 0 bytes whether or not the credential is there.
#
#   sh docs/superpowers/specs/experiments/2026-07-31-proc-gate2-exposed-set/probe-false-empty.sh
#
# Rows 1 and 5 are the same command. The only difference is that row 1 runs
# inside a command substitution. Row 1 reports an empty env block; rows 2-5 and
# the grep recover the credential from the same container.
#
# Only the BEHAVIOUR below is established. The kernel path that produces it is
# not — do not write it up as understood, and do not "fix" a probe by switching
# shells and assuming it now works. Assert against a known-present credential
# (a positive control) so an instrument that reads nothing fails loudly instead
# of passing.

set -eu

IMAGE="${1:-ghcr.io/quarrysystems/pangolin-worker:main}"

MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

docker run --rm -e SECRET=TOPSECRET-VALUE --entrypoint /bin/sh "$IMAGE" -c '
echo "1. $(wc -c < /proc/self/environ)  <- redirect inside $( ) : FALSE EMPTY"
echo "2. $(cat /proc/self/environ | wc -c)  <- pipe inside $( )"
echo "3. $(cat /proc/1/environ | wc -c)  <- explicit pid, inside $( )"
printf "5. "; wc -c < /proc/self/environ

echo
echo "positive control — the credential IS present the whole time:"
xargs -0 -n1 echo < /proc/1/environ | grep "^SECRET="
'

#!/bin/sh
# Container ENTRYPOINT — half one of C1'-restore (spec §7.2–7.3).
#
# THE FINDING this closes: a prompt-injected agent reads the worker's AWS chain
# and callback HMAC key reference straight out of /proc/<worker-pid>/environ.
# Same uid, no exploit. The runtime env filter scopes only the environment handed
# to the agent PROCESS, not the worker's own.
#
# THE MECHANISM: capture the ambient environment, hand it over an fd whose file is
# unlinked before the exec, and exec the worker with a clean envp. The worker
# restores the values into its own process.env (see src/credential-restore.ts),
# which lives in the heap and is NOT the region /proc exposes — that region is
# fixed at execve and never updated.
#
# `exec` is LOAD-BEARING. It calls execve(), so this shell does not survive to be
# read. That is precisely the defect that refuted the earlier C1 design, where a
# Node launcher could not replace its own image and stayed alive still holding
# the credential in its own /proc entry.

set -eu

umask 077
CRED_DIR=$(mktemp -d)

# EVERYTHING, not just the AWS chain. PANGOLIN_CALLBACK_TOKEN_REF and
# PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON are named targets of the finding, and any
# hand-maintained per-variable sensitivity list drifts out of date silently.
# NUL-separated (`env -0`) because bundle refs are arbitrary JSON whose values may
# contain literal newlines.
env -0 > "$CRED_DIR/payload"

# Open it, THEN remove it. The fd survives execve — a shell `exec N<` redirect
# sets no FD_CLOEXEC — but the directory entry does not survive this line, so
# there is no on-disk window in which the payload is reachable by name.
exec 3< "$CRED_DIR/payload"
rm -f "$CRED_DIR/payload"
rmdir "$CRED_DIR"

# `env -i` is the default-DENY polarity, and that is the point: an ambient
# variable nobody anticipated — a Fargate `secrets:[]` entry, a future AWS
# injection — is dropped because nobody listed it, rather than surviving because
# nobody blocked it. Only PATH and HOME are re-supplied, plus the fd pointer.
exec env -i \
  PATH="${PATH:-/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin}" \
  HOME="${HOME:-/home/pangolin}" \
  PANGOLIN_CRED_FD=3 \
  "$@"

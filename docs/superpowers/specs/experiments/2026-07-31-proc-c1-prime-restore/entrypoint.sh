#!/bin/sh
# C1'-restore: the shape the design commits to.
#
# Differs from C1' as written in the spec in one respect that matters: the
# hand-off file is UNLINKED BEFORE the exec, not by the worker after it. The
# credential rides an inherited fd to a file with no directory entry, so there
# is no on-disk window at all — not even a narrow one argued to be safe. The
# threat model already concedes that mode-0600 "doesn't protect against root or
# a same-uid process", and the agent is a same-uid process, so a window
# defended by a documented contract is not worth taking when the fd is free.
#
# `exec` is what makes this work at all: it calls execve(), so the kernel
# rebuilds the env region from the new envp and THIS PROCESS DOES NOT SURVIVE.
# That is the defect that refuted C1 — a Node launcher cannot replace its own
# image, so it stayed alive holding the credential.

set -eu

CRED_DIR=$(mktemp -d)
umask 077

# In the real entrypoint this loop covers the measured carry-list; one var is
# enough to demonstrate the channel.
printf '%s' "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" > "$CRED_DIR/creds"

# Open it, then remove it. The fd survives execve (no FD_CLOEXEC on a shell
# `exec N<` redirect); the directory entry does not survive this line.
exec 3< "$CRED_DIR/creds"
rm -f "$CRED_DIR/creds"
rmdir "$CRED_DIR"

echo "ENTRYPOINT (pid $$): credential on fd 3, file unlinked, exec'ing — this process ends here"

# env -i is the default-deny polarity gate item 2 argues for: carry what the
# worker needs, drop everything else, so an unknown ambient var (a Fargate
# secrets:[] entry, a future AWS injection) is dropped by construction.
exec env -i PATH="$PATH" HOME="$HOME" CRED_FD=3 node /w/worker-sim.mjs

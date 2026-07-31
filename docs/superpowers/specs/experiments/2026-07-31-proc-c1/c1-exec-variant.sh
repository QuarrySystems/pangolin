#!/bin/sh
# C1' — the shell-exec variant.
#
# The failure of C1-as-described is that a Node launcher CANNOT replace its own
# process image, so it survives holding the credentials. A POSIX shell CAN:
# `exec` calls execve(), and the kernel rebuilds the env region from the new
# envp. If that is true, no process in the namespace retains the credential.
#
# Credentials are handed over via a private file rather than an inherited pipe,
# because a pipe needs a live writer — which is the very process we are trying
# to remove. The worker reads and unlinks it before the agent ever starts.
set -eu

CREDS_DIR=/tmp/pangolin-creds
mkdir -p "$CREDS_DIR"
chmod 700 "$CREDS_DIR"
umask 077
printf '%s' "$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" > "$CREDS_DIR/creds"

echo "ENTRYPOINT (pid $$): credentials ambient; wrote them to $CREDS_DIR/creds"
echo "ENTRYPOINT: exec'ing the worker with env -i — this REPLACES this process"
echo ""

# `env -i` builds a minimal envp; `exec` replaces this shell's image with node's.
exec env -i PATH="$PATH" CREDS_FILE="$CREDS_DIR/creds" node /w/c1-exec-variant.mjs worker

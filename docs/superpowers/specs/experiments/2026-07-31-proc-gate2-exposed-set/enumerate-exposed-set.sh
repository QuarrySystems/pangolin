#!/bin/sh
# Gate item 2 — enumerate the set an injected agent actually recovers from the
# worker's env block, in the REAL worker image, on the local-docker path.
#
# Run from the repo root (the image tag is the only argument):
#
#   sh docs/superpowers/specs/experiments/2026-07-31-proc-gate2-exposed-set/enumerate-exposed-set.sh
#   sh .../enumerate-exposed-set.sh ghcr.io/quarrysystems/pangolin-worker:0.4.0
#
# The env below is the union of what `LocalDockerProvider` actually sets:
#   - `spec.env` built by pangolin-client `dispatch.ts:282-335`
#   - `extraEnv` (deploy-time static config — the documented home for AWS_*,
#     `providers-local-docker/src/index.ts:75-83`)
# plus whatever the image and the Docker daemon contribute, which is the half a
# code-reading enumeration misses. That is the reason this is a container run
# and not a grep.
#
# NOTE the probe. It reads `/proc/1/environ` from a CHILD started with `env -i`,
# which is the agent's real position: same uid, own environment already clean.
# It deliberately does NOT use `$(... < /proc/self/environ)` — see
# probe-false-empty.sh, which shows that construct reading 0 bytes while the
# credential is plainly present.

set -eu

IMAGE="${1:-ghcr.io/quarrysystems/pangolin-worker:main}"

# Git Bash / MSYS rewrites bare `/proc/...` and `s3://...` arguments into
# Windows paths. Without this the run silently probes the wrong thing.
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

echo "image: $IMAGE"

docker run --rm \
  -e AWS_ACCESS_KEY_ID=AKIA-EXPOSED-DEMO \
  -e AWS_SECRET_ACCESS_KEY=SECRET-EXPOSED-DEMO \
  -e AWS_SESSION_TOKEN=SESSION-EXPOSED-DEMO \
  -e AWS_REGION=us-east-1 \
  -e PANGOLIN_S3_ENDPOINT=http://minio:9000 \
  -e PANGOLIN_DISPATCH_ID=d-1 \
  -e PANGOLIN_NAMESPACE=ns \
  -e PANGOLIN_STORAGE_URI=s3://bkt \
  -e PANGOLIN_BUNDLE_REFS_JSON='{"subagent":{},"capabilities":[],"env":[]}' \
  -e PANGOLIN_INPUT_JSON={} \
  -e PANGOLIN_RUNTIME_ADAPTER=claude-code \
  -e PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON='{"ANTHROPIC_API_KEY":"local-secret://abc"}' \
  -e PANGOLIN_SECRET_STORE_KIND=local-file \
  -e PANGOLIN_SECRET_STORE_DIR=/pangolin/secrets \
  -e PANGOLIN_CALLBACK_URL=http://serve:8080/cb \
  -e PANGOLIN_CALLBACK_TOKEN_REF=local-secret://hmac \
  -e PANGOLIN_CALLBACK_BEARER_REF=local-secret://bearer \
  -e PANGOLIN_MODEL=sonnet \
  -e PANGOLIN_SETUP_TIMEOUT_SECONDS=120 \
  -e PANGOLIN_AGENT_TIMEOUT_SECONDS=7200 \
  -e PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS=300 \
  --entrypoint /bin/sh "$IMAGE" -c '
echo "worker  : pid 1, uid $(id -u), $(cat /proc/1/environ | wc -c) bytes in the env block"

env -i /bin/sh -c "
  echo \"agent   : pid \$\$, uid \$(id -u), own env: \$(cat /proc/self/environ | wc -c) bytes\"
  echo
  echo \"=== NAMES the agent recovers from /proc/1/environ ===\"
  xargs -0 -n1 echo < /proc/1/environ | sed \"s/=.*//\" | sort
  echo
  echo \"=== VALUES that are credentials or credential pointers ===\"
  xargs -0 -n1 echo < /proc/1/environ |
    grep -E \"^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|PANGOLIN_CALLBACK_TOKEN_REF|PANGOLIN_CALLBACK_BEARER_REF|PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON)=\"
"
'

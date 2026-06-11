#!/usr/bin/env bash
#
# health-check.sh — poll LocalStack health endpoint until S3 is ready.
#
# Used by CI and by humans verifying a local `docker compose up -d` worked.
# Exits 0 once the health endpoint reports S3 as "running" or "available",
# exits 1 if the timeout elapses first.
#
# LocalStack 2+ moved the health endpoint to /_localstack/health.
#
# Env:
#   PANGOLIN_TEST_S3_ENDPOINT   default http://localhost:4566
#   HEALTH_TIMEOUT_SECONDS   default 60
#   HEALTH_POLL_INTERVAL     default 2

set -euo pipefail

ENDPOINT="${PANGOLIN_TEST_S3_ENDPOINT:-http://localhost:4566}"
HEALTH_URL="${ENDPOINT%/}/_localstack/health"
TIMEOUT="${HEALTH_TIMEOUT_SECONDS:-60}"
INTERVAL="${HEALTH_POLL_INTERVAL:-2}"

echo "Polling ${HEALTH_URL} (timeout ${TIMEOUT}s, interval ${INTERVAL}s)..."

deadline=$(( $(date +%s) + TIMEOUT ))

while :; do
  now=$(date +%s)
  if (( now >= deadline )); then
    echo "ERROR: LocalStack health check timed out after ${TIMEOUT}s" >&2
    # Best-effort: print whatever the endpoint last returned to aid debugging.
    curl -sS "${HEALTH_URL}" >&2 || true
    echo >&2
    exit 1
  fi

  if body=$(curl -fsS "${HEALTH_URL}" 2>/dev/null); then
    # We only require S3 here. Accept either "running" or "available";
    # LocalStack has used both string values across 2.x/3.x.
    if echo "${body}" | grep -Eq '"s3"[[:space:]]*:[[:space:]]*"(running|available)"'; then
      echo "LocalStack S3 is ready."
      echo "${body}"
      exit 0
    fi
  fi

  sleep "${INTERVAL}"
done

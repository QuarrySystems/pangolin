#!/usr/bin/env sh
# init-buckets.sh — one-shot MinIO bucket initialisation for the serve stack.
#
# Byte-faithful copy of examples/offload-minio/scripts/init-buckets.sh
# (this header comment is the only delta).
#
# Run by the `minio-init` service after MinIO is healthy.
# Idempotent: both `mc mb` calls ignore "already exists" errors so re-runs are safe.
#
# Buckets created:
#   pangolin-audit  — object-lock enabled (COMPLIANCE mode required by S3ObjectLockAnchor)
#   pangolin-data   — normal bucket (storage + mailbox)
#
# Operator note: this script is executed inside the minio/mc container.
# The alias "myminio" is configured at container startup via MC_HOST_myminio.

set -e

echo "[init-buckets] Waiting for MinIO to be reachable via mc alias..."

# Retry mc alias list to confirm connectivity (minio healthcheck should already
# have passed, but a brief retry loop guards against transient failures).
RETRIES=10
i=0
until mc alias list myminio >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge "$RETRIES" ]; then
    echo "[init-buckets] ERROR: MinIO not reachable after $RETRIES attempts." >&2
    exit 1
  fi
  echo "[init-buckets] Waiting for mc alias... attempt $i/$RETRIES"
  sleep 2
done

echo "[init-buckets] Creating bucket pangolin-audit (with object lock)..."
# --with-lock enables S3 Object Lock (required for COMPLIANCE mode anchoring).
# --ignore-existing makes the command idempotent (exit 0 if bucket already exists).
mc mb --with-lock --ignore-existing myminio/pangolin-audit
mc ls myminio/pangolin-audit >/dev/null 2>&1 || { echo "[init-buckets] ERROR: pangolin-audit bucket not accessible after creation." >&2; exit 1; }

echo "[init-buckets] Creating bucket pangolin-data (standard)..."
mc mb --ignore-existing myminio/pangolin-data
mc ls myminio/pangolin-data >/dev/null 2>&1 || { echo "[init-buckets] ERROR: pangolin-data bucket not accessible after creation." >&2; exit 1; }

echo "[init-buckets] Bucket initialisation complete."
mc ls myminio

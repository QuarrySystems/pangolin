# LocalStack sandbox

A minimal, S3-only [LocalStack](https://docs.localstack.cloud/) instance used
by `pangolin-storage-s3` integration tests. Same compose file runs locally and in
CI (via GitHub Actions' container service feature) so behaviour stays
identical.

## Bring it up

```bash
docker compose -f docker/localstack/docker-compose.yml up -d
```

The S3 endpoint listens on `http://localhost:4566`.

Tear it down with:

```bash
docker compose -f docker/localstack/docker-compose.yml down
```

## Health check

LocalStack 2.x moved the health endpoint to `/_localstack/health` (the old
`/health` path is gone). Poll it directly:

```bash
curl -fsS http://localhost:4566/_localstack/health
```

Or run the bundled poller, which waits up to 60 seconds for S3 to report
`running`/`available`:

```bash
bash docker/localstack/test/health-check.sh
```

## Environment variables for tests

Integration tests in `packages/pangolin-storage-s3` expect these variables to be
set so the AWS SDK targets LocalStack instead of real AWS:

| Variable                    | Value                       | Why                                                                 |
| --------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `AWS_ACCESS_KEY_ID`         | `test`                      | LocalStack accepts any non-empty credentials; we standardise on `test`. |
| `AWS_SECRET_ACCESS_KEY`     | `test`                      | Same — pairs with the access key above.                             |
| `AWS_REGION`                | `us-east-1`                 | Matches `DEFAULT_REGION` in the compose file.                       |
| `PANGOLIN_TEST_S3_ENDPOINT`    | `http://localhost:4566`     | Tests read this to point the S3 client at LocalStack.               |

Example, in a POSIX shell:

```bash
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_REGION=us-east-1
export PANGOLIN_TEST_S3_ENDPOINT=http://localhost:4566
```

## CI usage

GitHub Actions consumes the same `docker-compose.yml` so the only thing that
changes between local and CI is who runs `docker compose up`. The workflow
calls `bash docker/localstack/test/health-check.sh` to gate the test step on
S3 readiness.

## Image pin

The image is pinned to `localstack/localstack:3.8` — never `:latest`. Bump
deliberately when upgrading.

## Further reading

- LocalStack docs: <https://docs.localstack.cloud/>
- S3 feature coverage: <https://docs.localstack.cloud/user-guide/aws/s3/>
- Health endpoint reference: <https://docs.localstack.cloud/references/internal-endpoints/#localstack-endpoints>

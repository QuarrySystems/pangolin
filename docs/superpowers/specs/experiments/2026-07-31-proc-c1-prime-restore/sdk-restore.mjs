// Does the AWS SDK's default chain pick up credentials placed in process.env
// AFTER the process started — and after a client was already constructed?
//
// This is the half that decides whether the restore mechanism needs any package
// API change at all. Constraint 6 of the spec observes that `remoteProvider`
// re-reads `process.env[ENV_CMDS_RELATIVE_URI]` on every chain invocation; that
// observation was made to explain why a naive scrub degrades badly. The same
// lateness is what makes the restore work. Observed-in-passing is not measured,
// so it is measured here.
//
// Deliberately tests the HARDER ordering: the client is built BEFORE the restore.
// The real worker restores first, so if this passes, the real ordering is safe.
import { S3Client } from '@aws-sdk/client-s3';

const show = (label, v) => console.log(`  ${label.padEnd(34)} ${v}`);

console.log('process starts with NO credentials in the environment');
show('AWS_ACCESS_KEY_ID at boot:', process.env.AWS_ACCESS_KEY_ID ?? '(unset)');

// Client constructed while the environment is still empty.
const client = new S3Client({ region: 'us-east-1' });

let before = 'resolved — UNEXPECTED';
try {
  await client.config.credentials();
} catch (err) {
  before = `${err.name}`;
}
show('resolve BEFORE restore:', before);

// The restore.
process.env.AWS_ACCESS_KEY_ID = 'AKIA-RESTORED-AFTER-START';
process.env.AWS_SECRET_ACCESS_KEY = 'secret-restored-after-start';
process.env.AWS_SESSION_TOKEN = 'session-restored-after-start';

let after;
try {
  const c = await client.config.credentials();
  after = c.accessKeyId;
} catch (err) {
  after = `FAILED — ${err.name}: ${err.message}`;
}
show('resolve AFTER restore:', after);

// The Fargate shape: a pointer to a refreshing endpoint rather than static keys.
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_SESSION_TOKEN;
process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/RESTORED-POINTER';

const client2 = new S3Client({ region: 'us-east-1' });
let pointer;
try {
  await client2.config.credentials();
  pointer = 'resolved (unexpected without a live ECS endpoint)';
} catch (err) {
  // Reaching the ECS credential endpoint at all proves the restored pointer was
  // read. Never reaching it — "could not load credentials from any providers" —
  // would prove the opposite.
  pointer = `${err.name}: ${String(err.message).slice(0, 90)}`;
}
show('fargate pointer AFTER restore:', pointer);

console.log(`
verdict: the STATIC lane resolves credentials that were absent at construction
time, so it needs no credentials seam on any client.

The pointer row above FAILS here, and that failure is NOT interpretable on its
own — a relative URI is hardwired to 169.254.170.2, which does not exist in a
plain container, so "could not load credentials from any providers" is what both
"never read the var" and "read it and could not reach the endpoint" look like.
Run sdk-restore-pointer.mjs, which separates them. (It answers: read it.)`);

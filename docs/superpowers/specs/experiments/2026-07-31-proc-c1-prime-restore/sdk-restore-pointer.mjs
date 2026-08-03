// Disambiguates the one FAILING row of sdk-restore.mjs.
//
// There, a restored `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` produced
// "Could not load credentials from any providers". Two readings fit that output
// and they imply opposite designs:
//
//   (a) the restored pointer was never read  -> the Fargate shape needs its own
//                                               handling, and the restore
//                                               mechanism is incomplete
//   (b) the pointer WAS read and 169.254.170.2 is simply unreachable in a plain
//       docker container -> the failure is the test's, not the mechanism's
//
// A relative URI is hardwired to the ECS link-local address, so it cannot be
// pointed anywhere testable. `AWS_CONTAINER_CREDENTIALS_FULL_URI` takes the same
// lane through the same provider but permits a loopback host — so a local server
// that either does or does not receive a request separates (a) from (b).
import { createServer } from 'node:http';
import { S3Client } from '@aws-sdk/client-s3';

let hits = 0;
const server = createServer((req, res) => {
  hits += 1;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      AccessKeyId: 'AKIA-FROM-ENDPOINT',
      SecretAccessKey: 'secret-from-endpoint',
      Token: 'token-from-endpoint',
      Expiration: new Date(Date.now() + 3600_000).toISOString(),
    }),
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/creds`;

const show = (l, v) => console.log(`  ${l.padEnd(38)} ${v}`);
const resolve = async (client) => {
  try {
    return (await client.config.credentials()).accessKeyId;
  } catch (err) {
    return `FAILED — ${err.name}: ${String(err.message).slice(0, 70)}`;
  }
};

// Baseline: pointer present before the client exists. Proves the lane works
// here at all — without this, a failure below would be uninterpretable.
process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = url;
show('pointer set BEFORE client:', await resolve(new S3Client({ region: 'us-east-1' })));
show('endpoint requests so far:', hits);

// The real question: client built while the environment is empty, pointer
// restored afterwards — the worst-case ordering for the restore mechanism.
delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
const late = new S3Client({ region: 'us-east-1' });
show('resolve with NO pointer:', await resolve(late));

process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = url;
show('pointer RESTORED after client:', await resolve(late));
show('endpoint requests total:', hits);

console.log(
  hits >= 2
    ? '\n=> (b): the pointer lane re-reads process.env late. The earlier failure was\n   an unreachable 169.254.170.2, not a mechanism defect.'
    : '\n=> (a): the restored pointer was NOT read. The Fargate shape needs its own\n   handling and the restore mechanism is incomplete as designed.',
);
server.close();

# Seal Signing-Key Custody (Production KMS Signer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production key-custody path to the audit seal — a pluggable `ecdsa-p256` signing algorithm, an AWS-KMS leaf signer, a published keyRef→pubkey trust root, and time-bounded rotation/revocation — without touching the demo/dev Ed25519 path or the seal crypto core.

**Architecture:** Additive throughout. `pangolin-core`'s `verify`/`verifyBundle` are already algorithm-agnostic (they consume an injected `verifySignature(root,sig)=>boolean` callback), so the new algorithm is added in the callback constructors plus a new `verifyEcdsaP256` sibling, leaving `verifyEd25519` and all its importers untouched. The KMS SDK lives only in a new leaf package implementing the existing `Signer` interface. The trust root is a published manifest the verifier loads out-of-band; revocation is time-bounded by the existing RFC-3161 trusted-time tier.

**Tech Stack:** TypeScript, pnpm workspace, vitest, node:crypto (no new crypto dep), `@aws-sdk/client-kms` (isolated to the new leaf package).

**Spec:** `docs/superpowers/specs/2026-06-15-seal-signing-key-custody-kms-design.md`

**Demand-pulled:** per `decision-2026-06-15-seal-signing-key-custody-demo-local`, this is built when a compliance design partner pulls it. This plan is the audited, ready-to-execute design.

---

## File structure

| File | Responsibility | Wave |
|------|----------------|------|
| `packages/pangolin-orchestrator/src/audit/signer.ts` (modify) | add `verifyEcdsaP256` + `createLocalEcdsaSigner` beside the untouched ed25519 funcs | A |
| `packages/pangolin-orchestrator/test/audit/signer.test.ts` (modify) | round-trip / tamper / wrong-key / malformed / alg-guard for ecdsa-p256 | A |
| `packages/pangolin-orchestrator/test/conformance/audit-vectors/sign-ecdsa-p256.json` (create) | frozen cross-version P-256 vector | A |
| `packages/pangolin-orchestrator/test/conformance/sign-ecdsa-p256.test.ts` (create) | assert the frozen vector verifies | A |
| `packages/pangolin-orchestrator/src/index.ts` (modify) + `test/barrel-audit-surface.test.ts` (modify) | export new symbols; update surface assertion | A |
| `packages/pangolin-verify/src/verify-context.ts` (modify) | alg-dispatch in `makeVerifySignature`; `trustRoot` field + keyRef resolution | A, C |
| `packages/pangolin-verify/src/trust-root.ts` (create) | manifest types + pure `resolveKey` resolver | C |
| `packages/pangolin-verify/test/trust-root.test.ts` (create) | resolver unit tests | C |
| `packages/pangolin-verify/test/verify-context-ecdsa.test.ts` (create) | ecdsa + trust-root integration | A, C |
| `packages/pangolin-signer-aws-kms/**` (create) | KMS `Signer` adapter + `publishablePublicKey`; sole `@aws-sdk/client-kms` owner | B |
| `packages/pangolin-verify/src/timestamp-authority.ts` (modify) | surface verified `genTime` (additive; `verifyTimestamp` stays boolean) | D |
| `packages/pangolin-verify/src/revocation.ts` (create) | time-bounded revocation decision over a resolved key + verified genTime | D |
| `packages/pangolin-verify/test/revocation.test.ts` (create) | hard-fail + soft time-bounded cases | D |
| `docs-site/src/content/docs/reference/trust-root.md` (create) + `deploy/serve-stack/client/pangolin.config.mjs` (example, documented) | publication format + wiring example | E |

---

## Wave A — ECDSA-P256 algorithm primitives

### Task 1: `verifyEcdsaP256` + `createLocalEcdsaSigner`

**Files:**
- Modify: `packages/pangolin-orchestrator/src/audit/signer.ts`
- Test: `packages/pangolin-orchestrator/test/audit/signer.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `signer.test.ts`; import the two new symbols on line 5)

Change line 5 to:
```ts
import { createLocalSigner, createLocalEcdsaSigner, verifyEd25519, verifyEcdsaP256, NoneSigner } from '../../src/audit/signer.js';
```
Append:
```ts
it('LocalEcdsaSigner round-trips; tampered root fails', async () => {
  const s = createLocalEcdsaSigner('ec-local');
  const root = new Uint8Array(32).fill(7);
  const sig = await s.sign(root);
  expect(sig.alg).toBe('ecdsa-p256');
  expect(sig.keyRef).toBe('ec-local');
  expect(verifyEcdsaP256(root, sig, s.publicKey)).toBe(true);
  expect(verifyEcdsaP256(new Uint8Array(32).fill(8), sig, s.publicKey)).toBe(false);
});

it('verifyEcdsaP256 rejects a non-ecdsa-p256 alg (alg guard)', async () => {
  const ed = createLocalSigner();
  const root = new Uint8Array(32).fill(7);
  const edSig = await ed.sign(root); // alg 'ed25519'
  const ec = createLocalEcdsaSigner();
  expect(verifyEcdsaP256(root, edSig, ec.publicKey)).toBe(false);
});

it('verifyEcdsaP256 wrong-key and malformed SPKI return false without throwing', async () => {
  const a = createLocalEcdsaSigner('a');
  const b = createLocalEcdsaSigner('b');
  const root = new Uint8Array(32).fill(42);
  const sig = await a.sign(root);
  expect(verifyEcdsaP256(root, sig, b.publicKey)).toBe(false);
  expect(verifyEcdsaP256(root, sig, new Uint8Array([1, 2, 3]))).toBe(false);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator test -- signer`
Expected: FAIL — `createLocalEcdsaSigner`/`verifyEcdsaP256` are not exported.

- [ ] **Step 3: Implement (append to `signer.ts`)**

```ts
/** ec/P-256 local signer; signs SHA-256(root) (DER ECDSA), public key SPKI-DER.
 *  Test/dev parity for the production KMS path (KMS ECC_NIST_P256 / ECDSA_SHA_256
 *  produces the SAME format). NOT a production signer. */
export function createLocalEcdsaSigner(keyRef = 'local-ecdsa'): Signer & { publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    keyRef,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    async sign(root: Uint8Array): Promise<Signature> {
      // 'sha256' digest algo => node hashes root then ECDSA-signs; DER is node's default.
      return { alg: 'ecdsa-p256', bytes: new Uint8Array(nodeSign('sha256', Buffer.from(root), privateKey)), keyRef };
    },
  };
}

/** Verify an ecdsa-p256 signature (DER, over SHA-256(root)) against an SPKI-DER P-256 key.
 *  Mirrors the KMS verify contract: ECDSA_SHA_256 + DER. */
export function verifyEcdsaP256(root: Uint8Array, sig: Signature, spkiDer: Uint8Array): boolean {
  if (sig.alg !== 'ecdsa-p256') return false;
  try {
    const key = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
    return nodeVerify('sha256', Buffer.from(root), key, Buffer.from(sig.bytes));
  } catch {
    return false;
  }
}
```
> `generateKeyPairSync`, `sign as nodeSign`, `verify as nodeVerify`, `createPublicKey` are already imported at `signer.ts:1`. `verifyEd25519` and `createLocalSigner` are NOT modified.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator test -- signer`
Expected: PASS (all original ed25519 tests + the 3 new ecdsa tests).

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-orchestrator/src/audit/signer.ts packages/pangolin-orchestrator/test/audit/signer.test.ts
git commit -m "feat(seal): add ecdsa-p256 local signer + verifier (pluggable alg)"
```

---

### Task 2: frozen `ecdsa-p256` conformance vector

**Files:**
- Create: `packages/pangolin-orchestrator/test/conformance/audit-vectors/sign-ecdsa-p256.json`
- Create: `packages/pangolin-orchestrator/test/conformance/sign-ecdsa-p256.test.ts`

> ECDSA is non-deterministic (random `k`), so — unlike the ed25519 vector — we cannot pin a single expected `signatureHex`. The vector pins the **key material + root**, and the test asserts (a) the pinned signature verifies, and (b) a wrong root does not. Generate the vector once with the snippet in Step 1.

- [ ] **Step 1: Generate + write the vector**

Generate values locally (one-off):
```bash
node -e "const c=require('crypto');const {privateKey,publicKey}=c.generateKeyPairSync('ec',{namedCurve:'P-256'});const root=Buffer.alloc(32,7);const sig=c.sign('sha256',root,privateKey);console.log(JSON.stringify({description:'ecdsa-p256/SPKI signature vector (DER over SHA-256(root))',rootHex:root.toString('hex'),publicKeySpkiDerHex:publicKey.export({type:'spki',format:'der'}).toString('hex'),signatureHex:sig.toString('hex')},null,2))"
```
Paste the output into `sign-ecdsa-p256.json`.

- [ ] **Step 2: Write the test**

```ts
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEcdsaP256 } from '../../src/audit/signer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const vec = JSON.parse(readFileSync(resolve(__dirname, 'audit-vectors/sign-ecdsa-p256.json'), 'utf8'));

it('frozen ecdsa-p256 vector: the pinned signature verifies, a wrong root does not', () => {
  const root = Uint8Array.from(Buffer.from(vec.rootHex, 'hex'));
  const sig = { alg: 'ecdsa-p256', bytes: Uint8Array.from(Buffer.from(vec.signatureHex, 'hex')) };
  const pub = Uint8Array.from(Buffer.from(vec.publicKeySpkiDerHex, 'hex'));
  expect(verifyEcdsaP256(root, sig, pub)).toBe(true);
  expect(verifyEcdsaP256(new Uint8Array(32).fill(1), sig, pub)).toBe(false);
});
```

- [ ] **Step 3: Run, verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator test -- sign-ecdsa-p256`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/pangolin-orchestrator/test/conformance/audit-vectors/sign-ecdsa-p256.json packages/pangolin-orchestrator/test/conformance/sign-ecdsa-p256.test.ts
git commit -m "test(seal): pin ecdsa-p256 conformance vector"
```

---

### Task 3: barrel exports + surface assertion

**Files:**
- Modify: `packages/pangolin-orchestrator/src/index.ts`
- Test: `packages/pangolin-orchestrator/test/barrel-audit-surface.test.ts`

- [ ] **Step 1: Update the surface test** (line 1 lists the imported surface; add the two symbols)

In `barrel-audit-surface.test.ts:1`, add `createLocalEcdsaSigner, verifyEcdsaP256` to the import list, and add assertions mirroring the existing ones:
```ts
expect(typeof createLocalEcdsaSigner).toBe('function');
expect(typeof verifyEcdsaP256).toBe('function');
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator test -- barrel-audit-surface`
Expected: FAIL — symbols not exported from the barrel.

- [ ] **Step 3: Export from the barrel**

In `packages/pangolin-orchestrator/src/index.ts`, find the existing `createLocalSigner, verifyEd25519` re-export from `./audit/signer.js` and add `createLocalEcdsaSigner, verifyEcdsaP256` to it.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator test -- barrel-audit-surface`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-orchestrator/src/index.ts packages/pangolin-orchestrator/test/barrel-audit-surface.test.ts
git commit -m "feat(seal): export ecdsa-p256 signer/verifier from orchestrator barrel"
```

---

### Task 4: alg-dispatch in the standalone verifier

**Files:**
- Modify: `packages/pangolin-verify/src/verify-context.ts:177-189` (`makeVerifySignature`)
- Test: `packages/pangolin-verify/test/verify-context-ecdsa.test.ts` (create)

> This task makes `makeVerifySignature` dispatch on `sig.alg` for the **single-key** path. The keyRef/trust-root map comes in Task 9. Until then the existing single `signerPublicKey` is used for whichever alg the sig declares.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createPublicKey } from 'node:crypto';
import { createLocalEcdsaSigner } from '@quarry-systems/pangolin-orchestrator';
import { makeVerifySignature, type VerifyContext } from '../src/verify-context.js';

describe('makeVerifySignature alg dispatch', () => {
  it('verifies an ecdsa-p256 signature against the configured P-256 SPKI key', async () => {
    const s = createLocalEcdsaSigner('ec1');
    const root = new Uint8Array(32).fill(9);
    const sig = await s.sign(root);
    const ctx = {
      signerPublicKey: createPublicKey({ key: Buffer.from(s.publicKey), format: 'der', type: 'spki' }),
      anchor: { mode: 'offline' },
      tsaCaCertsDer: [],
    } as unknown as VerifyContext;
    const verify = makeVerifySignature(ctx)!;
    expect(verify(root, sig)).toBe(true);
    expect(verify(new Uint8Array(32).fill(8), sig)).toBe(false);
  });

  it('returns undefined when no signer key is configured (→ core n/a)', () => {
    const ctx = { anchor: { mode: 'offline' }, tsaCaCertsDer: [] } as unknown as VerifyContext;
    expect(makeVerifySignature(ctx)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-verify test -- verify-context-ecdsa`
Expected: FAIL — the ecdsa case returns false (the current code only does `edVerify(null,…)`).

- [ ] **Step 3: Implement the SHARED dispatch primitive + use it in `makeVerifySignature`** (`verify-context.ts:177`)

Add ONE module-private primitive that owns the `alg → node-verify` mapping, so the dispatch is written exactly once (DRY — Task 9's trust-root callback reuses it instead of re-inlining the same `if/else`):

```ts
/** The single algorithm→node-crypto-verify mapping. ed25519 = PureEdDSA (digest null);
 *  ecdsa-p256 = ECDSA over SHA-256, DER (node's default). Unknown alg → false. Never throws.
 *  Sole place the per-alg verify is written; all verify callbacks in this module route through it. */
function verifySignatureBytes(alg: string, root: Uint8Array, key: KeyObject, sigBytes: Uint8Array): boolean {
  try {
    if (alg === 'ed25519') return edVerify(null, Buffer.from(root), key, Buffer.from(sigBytes));
    if (alg === 'ecdsa-p256') return edVerify('sha256', Buffer.from(root), key, Buffer.from(sigBytes));
    return false;
  } catch {
    return false;
  }
}

export function makeVerifySignature(
  ctx: VerifyContext,
): ((root: Uint8Array, sig: Signature) => boolean) | undefined {
  const key = ctx.signerPublicKey;
  if (!key) return undefined;
  return (root, sig) => verifySignatureBytes(sig.alg, root, key, sig.bytes);
}
```
> `edVerify` is the node `verify` already imported at `verify-context.ts:8`; `KeyObject` is imported there too (`:8`). `'sha256'` selects ECDSA-over-SHA-256; `null` is the EdDSA path. DER is node's default ECDSA encoding — matches KMS + `createLocalEcdsaSigner`. (The orchestrator's `verifyEd25519`/`verifyEcdsaP256` in `signer.ts` stay separate primitives — `pangolin-verify` cannot import `pangolin-orchestrator` runtime code, enforced by `packages/pangolin-verify/test/no-orchestrator-dep.test.ts`; cross-package duplication of the raw verify is the accepted repo pattern, and `pangolin-core` deliberately owns no signature crypto. So "DRY" here means one primitive *within pangolin-verify*, not one across the whole repo.)

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-verify test -- verify-context-ecdsa`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-verify/src/verify-context.ts packages/pangolin-verify/test/verify-context-ecdsa.test.ts
git commit -m "feat(verify): dispatch signature verification on sig.alg (ed25519 | ecdsa-p256)"
```

---

## Wave B — AWS KMS leaf signer package

### Task 5: scaffold `pangolin-signer-aws-kms`

**Files:**
- Create: `packages/pangolin-signer-aws-kms/package.json`
- Create: `packages/pangolin-signer-aws-kms/tsconfig.json`
- Create: whatever other config files the sibling `pangolin-providers-aws-creds` has (e.g. `README.md`, `LICENSE`; copy `vitest.config.ts` ONLY if the sibling has one — do not invent config the sibling lacks)
- Create: `packages/pangolin-signer-aws-kms/src/index.ts` (skeleton)

> Follow the repo `new-package` skill. **Copy `packages/pangolin-providers-aws-creds` VERBATIM** as the template (it is the cleanest AWS-SDK leaf: one AWS dep + core, no dev deps, plain `build: tsc`) and change only the name + deps. Grounded facts about the canonical leaf shape (verified across all leaf packages):
> - **Do NOT add `"type": "module"`.** No AWS-SDK leaf sets it — `aws-creds`, `storage-s3`, `providers-fargate`, `secret-store` are all CJS-output compiled by `tsc` under `module: NodeNext` (the only ESM package in the repo is `pangolin-verify`, which has no AWS dep). Copying the sibling's `package.json` verbatim is correct; adding `"type":"module"` would diverge from every AWS leaf and risk CJS/ESM interop surprises under NodeNext. The `.js` import specifiers in this plan's code work under NodeNext CJS exactly as they do in the sibling packages.
> - **No `exports` field** — use the flat `main: dist/index.js` + `types: dist/index.d.ts` pair (the convention across all nine leaves).
> - **`tsconfig.json` is identical for every leaf:** `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*"] }`. Copy it unchanged.
> - **Scripts (identical across all leaves):** `lint: eslint src --ext .ts`, `test: vitest run`, `typecheck: tsc --noEmit`, `build: tsc`, `clean: rm -rf dist`.
> - Carry the shared fields the siblings have: `version: 0.2.0`, `license: BUSL-1.1`, `publishConfig.access: public`, `files: [dist, README.md, LICENSE]`, and the `repository`/`homepage`/`bugs` blocks.
>
> Dependencies: `@quarry-systems/pangolin-core: workspace:*` (for the `Signer`/`Signature` types) and `@aws-sdk/client-kms: ^3.700.0` (**match the `^3.700.0` floor the other `@aws-sdk/client-*` packages pin** — `client-s3`, `client-ecs`, `client-secrets-manager`; this is a brand-new workspace dependency, so `pnpm install` updates `pnpm-lock.yaml`). This package is the SOLE owner of the KMS SDK.
>
> **Naming (resolved):** `pangolin-signer-aws-kms` — a new `signer-*` family keyed to the `Signer` seam (the repo's `providers-*`/`storage-*`/`runtime-*` prefixes each map to a seam, and a signer is neither a provider nor storage). Confirm consistency with ADR-0001 when creating the package.

- [ ] **Step 1: Copy the sibling package skeleton**

Copy the sibling's actual files (`ls packages/pangolin-providers-aws-creds` first; copy exactly those). In `package.json`: name `@quarry-systems/pangolin-signer-aws-kms`, set `dependencies` to `@aws-sdk/client-kms: ^3.700.0` + `@quarry-systems/pangolin-core: workspace:*`, and keep the sibling's `scripts` unchanged (do not add `"type":"module"`; do not add an `exports` field). Also fix the README scope strings to `@quarry-systems/...` (the sibling's README has a known `-systems/...` corruption — don't copy that bug).

- [ ] **Step 2: Write a placeholder `src/index.ts`**

```ts
// @quarry-systems/pangolin-signer-aws-kms
// AWS KMS asymmetric ECDSA-P256 signer behind the core `Signer` seam.
// SOLE owner of @aws-sdk/client-kms; pangolin-core/pangolin-verify gain no SDK dependency.
export {}; // filled in by Tasks 6-7
```

- [ ] **Step 3: Install + verify the workspace sees the package**

Run: `pnpm install && pnpm --filter @quarry-systems/pangolin-signer-aws-kms typecheck`
Expected: PASS (no errors; empty module typechecks).

- [ ] **Step 4: Commit**

```bash
git add packages/pangolin-signer-aws-kms pnpm-lock.yaml
git commit -m "chore(kms-signer): scaffold pangolin-signer-aws-kms package"
```

---

### Task 6: `createKmsSigner`

**Files:**
- Modify: `packages/pangolin-signer-aws-kms/src/index.ts`
- Test: `packages/pangolin-signer-aws-kms/test/kms-signer.test.ts` (create)

- [ ] **Step 1: Write the failing test** (inject a fake KMS client — no network)

```ts
import { describe, it, expect } from 'vitest';
import { createPublicKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { verifyEcdsaP256 } from '@quarry-systems/pangolin-orchestrator';
import { createKmsSigner } from '../src/index.js';

// A fake that signs locally with a P-256 key and returns a DER signature, exactly as
// KMS ECC_NIST_P256 / ECDSA_SHA_256 / MessageType:RAW does. The implementation passes a
// REAL `new SignCommand(input)`, which exposes its params on `.input` (no `__type` field) —
// so assert on `cmd.input.*`, the genuine SDK shape, not a fake-only discriminator.
function fakeKmsClient() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    spkiDer: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    async send(cmd: { input: { Message: Uint8Array; MessageType: string; SigningAlgorithm: string } }) {
      expect(cmd.input.MessageType).toBe('RAW');
      expect(cmd.input.SigningAlgorithm).toBe('ECDSA_SHA_256');
      const der = nodeSign('sha256', Buffer.from(cmd.input.Message), privateKey);
      return { Signature: new Uint8Array(der) };
    },
  };
}

describe('createKmsSigner', () => {
  it('produces an ecdsa-p256 Signature KMS-style; verifies against the KMS public key', async () => {
    const fake = fakeKmsClient();
    const signer = createKmsSigner({ keyId: 'arn:aws:kms:...:key/abc', keyRef: 'pangolin-prod-2026', client: fake as never });
    const root = new Uint8Array(32).fill(5);
    const sig = await signer.sign(root);
    expect(sig.alg).toBe('ecdsa-p256');
    expect(sig.keyRef).toBe('pangolin-prod-2026');
    expect(verifyEcdsaP256(root, sig, fake.spkiDer)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-signer-aws-kms test -- kms-signer`
Expected: FAIL — `createKmsSigner` not exported.

- [ ] **Step 3: Implement**

```ts
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import type { Signer, Signature } from '@quarry-systems/pangolin-core';

export interface KmsSignerOptions {
  /** KMS key ARN/alias used for the Sign call (AWS-internal locator). */
  keyId: string;
  /** Stable audit-facing public identifier sealed into Signature.keyRef and resolved
   *  against the published trust root. Distinct from keyId on purpose. */
  keyRef: string;
  region?: string;
  /** Inject a client (tests). Defaults to a real KMSClient. */
  client?: Pick<KMSClient, 'send'>;
}

/** Production signer: KMS ECC_NIST_P256 / ECDSA_SHA_256 over the raw 32-byte root.
 *  KMS hashes the message with SHA-256 (MessageType RAW) and returns a DER ECDSA sig —
 *  byte-compatible with verifyEcdsaP256. The private key never leaves KMS. */
export function createKmsSigner(opts: KmsSignerOptions): Signer {
  const client = opts.client ?? new KMSClient(opts.region ? { region: opts.region } : {});
  return {
    keyRef: opts.keyRef,
    async sign(root: Uint8Array): Promise<Signature> {
      const out = await client.send(
        new SignCommand({
          KeyId: opts.keyId,
          Message: root,
          MessageType: 'RAW',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }) as never,
      );
      const der = (out as { Signature?: Uint8Array }).Signature;
      if (!der) throw new Error('KMS Sign returned no Signature');
      return { alg: 'ecdsa-p256', bytes: new Uint8Array(der), keyRef: opts.keyRef };
    },
  };
}
```
> **VERIFY-AT-BUILD (not code-grounded here):** `@aws-sdk/client-kms` is a brand-new dependency — it is NOT installed in the workspace today, so the SDK surface used here (`KMSClient`, `SignCommand`/`GetPublicKeyCommand`, the `KeyId`/`Message`/`MessageType:'RAW'`/`SigningAlgorithm:'ECDSA_SHA_256'` input fields, the `Signature`/`PublicKey` outputs, and that `MessageType:'RAW'` ⇒ KMS hashes with SHA-256 then signs) is from AWS SDK/KMS documentation, NOT verified against installed code. The injected-fake test proves only the ADAPTER's shape and the byte-compatibility with `verifyEcdsaP256`; it does NOT prove the real KMS contract. On first build, confirm the command/field names against the installed `@aws-sdk/client-kms` types and run one real `Sign`+`verifyEcdsaP256` round-trip against a test KMS key before trusting the path.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-signer-aws-kms test -- kms-signer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-signer-aws-kms/src/index.ts packages/pangolin-signer-aws-kms/test/kms-signer.test.ts
git commit -m "feat(kms-signer): createKmsSigner over KMS ECC_NIST_P256/ECDSA_SHA_256"
```

---

### Task 7: `publishablePublicKey` (GetPublicKey → manifest entry)

**Files:**
- Modify: `packages/pangolin-signer-aws-kms/src/index.ts`
- Test: `packages/pangolin-signer-aws-kms/test/publishable-key.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { publishablePublicKey } from '../src/index.js';

describe('publishablePublicKey', () => {
  it('returns a manifest entry with base64 SPKI-DER and alg ecdsa-p256', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
    const fake = { async send() { return { PublicKey: spki, KeySpec: 'ECC_NIST_P256' }; } };
    const entry = await publishablePublicKey({ keyId: 'arn:...', keyRef: 'pangolin-prod-2026', client: fake as never });
    expect(entry.keyRef).toBe('pangolin-prod-2026');
    expect(entry.alg).toBe('ecdsa-p256');
    expect(entry.spkiDer).toBe(Buffer.from(spki).toString('base64'));
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-signer-aws-kms test -- publishable-key`
Expected: FAIL — `publishablePublicKey` not exported.

- [ ] **Step 3: Implement (append to `src/index.ts`)**

```ts
import { GetPublicKeyCommand } from '@aws-sdk/client-kms';

export interface PublishableKey {
  keyRef: string;
  alg: 'ecdsa-p256';
  /** base64 SPKI-DER, ready to drop into a trust-root manifest entry. */
  spkiDer: string;
}

/** Fetch the KMS public key (SPKI-DER) and shape it as a trust-root manifest entry.
 *  Operators run this to publish key material — never hand-encode it. */
export async function publishablePublicKey(opts: {
  keyId: string;
  keyRef: string;
  region?: string;
  client?: Pick<KMSClient, 'send'>;
}): Promise<PublishableKey> {
  const client = opts.client ?? new KMSClient(opts.region ? { region: opts.region } : {});
  const out = await client.send(new GetPublicKeyCommand({ KeyId: opts.keyId }) as never);
  const spki = (out as { PublicKey?: Uint8Array }).PublicKey;
  if (!spki) throw new Error('KMS GetPublicKey returned no PublicKey');
  return { keyRef: opts.keyRef, alg: 'ecdsa-p256', spkiDer: Buffer.from(spki).toString('base64') };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-signer-aws-kms test -- publishable-key`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-signer-aws-kms/src/index.ts packages/pangolin-signer-aws-kms/test/publishable-key.test.ts
git commit -m "feat(kms-signer): publishablePublicKey emits a trust-root manifest entry"
```

---

## Wave C — Published trust root (keyRef → pubkey)

### Task 8: trust-root manifest types + `resolveKey`

**Files:**
- Create: `packages/pangolin-verify/src/trust-root.ts`
- Test: `packages/pangolin-verify/test/trust-root.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resolveKey, type TrustRoot } from '../src/trust-root.js';

const tr: TrustRoot = {
  schemaVersion: 1,
  keys: {
    'k-active': { alg: 'ecdsa-p256', spkiDer: 'AAAA', status: 'active', notBefore: '2026-01-01T00:00:00Z' },
    'k-revoked': { alg: 'ecdsa-p256', spkiDer: 'BBBB', status: 'revoked', notBefore: '2026-01-01T00:00:00Z', revokedAt: '2026-06-01T00:00:00Z' },
  },
};

describe('resolveKey', () => {
  it('resolves an active key by keyRef', () => {
    const e = resolveKey(tr, 'k-active');
    expect(e?.status).toBe('active');
    expect(e?.alg).toBe('ecdsa-p256');
  });
  it('resolves a revoked key (status carried through; decision is the revocation layer)', () => {
    expect(resolveKey(tr, 'k-revoked')?.revokedAt).toBe('2026-06-01T00:00:00Z');
  });
  it('returns undefined for an unknown keyRef', () => {
    expect(resolveKey(tr, 'nope')).toBeUndefined();
  });
  it('returns undefined for an undefined keyRef', () => {
    expect(resolveKey(tr, undefined)).toBeUndefined();
  });
});

describe('parseTrustRoot (validate an UNTRUSTED manifest — it is the security root)', () => {
  const okJson = JSON.stringify(tr);
  it('accepts a well-formed manifest', () => {
    expect(parseTrustRoot(okJson).keys['k-active'].alg).toBe('ecdsa-p256');
  });
  it('rejects unknown schemaVersion', () => {
    expect(() => parseTrustRoot(JSON.stringify({ schemaVersion: 2, keys: {} }))).toThrow(/schemaVersion/);
  });
  it('rejects a non-enum alg', () => {
    expect(() => parseTrustRoot(JSON.stringify({ schemaVersion: 1, keys: { k: { alg: 'rsa', spkiDer: 'AA', status: 'active', notBefore: '2026-01-01T00:00:00Z' } } }))).toThrow(/alg/);
  });
  it('rejects a revoked entry missing revokedAt', () => {
    expect(() => parseTrustRoot(JSON.stringify({ schemaVersion: 1, keys: { k: { alg: 'ed25519', spkiDer: 'AA', status: 'revoked', notBefore: '2026-01-01T00:00:00Z' } } }))).toThrow(/revokedAt/);
  });
  it('rejects a non-strict (offset-less) ISO timestamp', () => {
    expect(() => parseTrustRoot(JSON.stringify({ schemaVersion: 1, keys: { k: { alg: 'ed25519', spkiDer: 'AA', status: 'active', notBefore: '2026-01-01 00:00:00' } } }))).toThrow(/notBefore|ISO/);
  });
  it('rejects malformed JSON', () => {
    expect(() => parseTrustRoot('{not json')).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-verify test -- trust-root`
Expected: FAIL — `resolveKey`/`parseTrustRoot`/types missing.

- [ ] **Step 3: Implement** (one responsibility per export: types, a pure lookup, and a strict parser/validator)

```ts
// Published, out-of-band trust root mapping keyRef -> public key + lifecycle. NEVER
// read from the bundle (a bundle-supplied key is self-attesting/forgeable — rejected
// in PR #70). The auditor supplies this via the verify-context.
export interface TrustRootKey {
  alg: 'ed25519' | 'ecdsa-p256';
  /** base64 SPKI-DER. */
  spkiDer: string;
  status: 'active' | 'revoked';
  notBefore: string;            // strict ISO-8601 with offset/Z
  notAfter?: string | null;     // strict ISO-8601 | null
  revokedAt?: string | null;    // strict ISO-8601 | null (REQUIRED iff status==='revoked')
}

export interface TrustRoot {
  schemaVersion: 1;
  keys: Record<string, TrustRootKey>;
}

const ALGS = new Set(['ed25519', 'ecdsa-p256']);
// Strict ISO-8601 with an explicit Z or ±hh:mm offset, so Date.parse is unambiguous (not local-TZ).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function assertIso(v: unknown, field: string): string {
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error(`trust-root: ${field} must be strict ISO-8601 with offset, got ${String(v)}`);
  }
  return v;
}

/** Pure lookup of a key entry by keyRef. The lifecycle DECISION lives in the revocation
 *  layer (Task 11, keyUsableAt); this only resolves the entry. */
export function resolveKey(tr: TrustRoot, keyRef: string | undefined): TrustRootKey | undefined {
  if (!keyRef) return undefined;
  return tr.keys[keyRef];
}

/** Parse + validate an UNTRUSTED trust-root JSON string. Throws on anything malformed —
 *  the manifest is the security root, so fail closed rather than silently degrade. */
export function parseTrustRoot(json: string): TrustRoot {
  const raw = JSON.parse(json) as unknown;            // throws on bad JSON
  if (!raw || typeof raw !== 'object') throw new Error('trust-root: not an object');
  const o = raw as { schemaVersion?: unknown; keys?: unknown };
  if (o.schemaVersion !== 1) throw new Error(`trust-root: unsupported schemaVersion ${String(o.schemaVersion)}`);
  if (!o.keys || typeof o.keys !== 'object') throw new Error('trust-root: keys must be an object');
  const keys: Record<string, TrustRootKey> = {};
  for (const [ref, v] of Object.entries(o.keys as Record<string, unknown>)) {
    const e = v as Record<string, unknown>;
    if (!ALGS.has(e.alg as string)) throw new Error(`trust-root: key ${ref} has invalid alg ${String(e.alg)}`);
    if (typeof e.spkiDer !== 'string' || e.spkiDer.length === 0) throw new Error(`trust-root: key ${ref} missing spkiDer`);
    if (e.status !== 'active' && e.status !== 'revoked') throw new Error(`trust-root: key ${ref} invalid status`);
    assertIso(e.notBefore, `key ${ref} notBefore`);
    if (e.notAfter != null) assertIso(e.notAfter, `key ${ref} notAfter`);
    if (e.status === 'revoked') assertIso(e.revokedAt, `key ${ref} revokedAt (required for revoked)`);
    else if (e.revokedAt != null) assertIso(e.revokedAt, `key ${ref} revokedAt`);
    keys[ref] = {
      alg: e.alg as TrustRootKey['alg'], spkiDer: e.spkiDer, status: e.status,
      notBefore: e.notBefore as string,
      notAfter: (e.notAfter as string | null) ?? null,
      revokedAt: (e.revokedAt as string | null) ?? null,
    };
  }
  return { schemaVersion: 1, keys };
}
```
> `loadVerifyContext` (Task 9) must call `parseTrustRoot` when reading a manifest from disk/JSON — never `JSON.parse` it raw. An inline `trustRoot` object supplied programmatically by a trusted caller may bypass the parser (it is already typed), but file/network-sourced manifests go through `parseTrustRoot`.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-verify test -- trust-root`
Expected: PASS (lookup + all 6 validator cases).

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-verify/src/trust-root.ts packages/pangolin-verify/test/trust-root.test.ts
git commit -m "feat(verify): trust-root manifest types + resolveKey + strict parseTrustRoot validator"
```

---

### Task 9: wire `trustRoot` into the verify-context + keyRef resolution

**Files:**
- Modify: `packages/pangolin-verify/src/verify-context.ts` (`VerifyContextJson`, `VerifyContext`, `loadVerifyContext`, `makeVerifySignature`)
- Test: `packages/pangolin-verify/test/verify-context-ecdsa.test.ts` (extend)

> Resolution rule (spec §6.2): **no trust root configured at all → `undefined`** (core records `'n/a'`, unchanged). **Trust root configured but `sig.keyRef` unknown/absent → the verify callback returns `false`** (unrecognized signer is a hard fail). **Known keyRef → dispatch on the entry's `alg` (must equal `sig.alg`) against `entry.spkiDer`.** The existing single `signerPublicKeySpkiDer` shorthand is preserved.

- [ ] **Step 1: Write the failing tests** (append to `verify-context-ecdsa.test.ts`)

```ts
import { makeVerifySignatureFromTrustRoot } from '../src/verify-context.js';
import type { TrustRoot } from '../src/trust-root.js';

it('trust root: known keyRef verifies; unknown keyRef hard-fails; none → undefined', async () => {
  const s = createLocalEcdsaSigner('k-active');
  const root = new Uint8Array(32).fill(3);
  const sig = await s.sign(root); // keyRef 'k-active', alg ecdsa-p256
  const tr: TrustRoot = {
    schemaVersion: 1,
    keys: { 'k-active': { alg: 'ecdsa-p256', spkiDer: Buffer.from(s.publicKey).toString('base64'), status: 'active', notBefore: '2026-01-01T00:00:00Z' } },
  };
  const verify = makeVerifySignatureFromTrustRoot(tr)!;
  expect(verify(root, sig)).toBe(true);
  // unknown keyRef -> hard fail
  const sigUnknown = { ...sig, keyRef: 'ghost' };
  expect(verify(root, sigUnknown)).toBe(false);
  // no trust root at all -> undefined (n/a)
  expect(makeVerifySignatureFromTrustRoot(undefined)).toBeUndefined();
});

it('trust root: entry alg must match sig alg', async () => {
  const s = createLocalEcdsaSigner('k-active');
  const root = new Uint8Array(32).fill(3);
  const sig = await s.sign(root);
  const tr: TrustRoot = {
    schemaVersion: 1,
    keys: { 'k-active': { alg: 'ed25519', spkiDer: Buffer.from(s.publicKey).toString('base64'), status: 'active', notBefore: '2026-01-01T00:00:00Z' } },
  };
  expect(makeVerifySignatureFromTrustRoot(tr)!(root, sig)).toBe(false); // alg mismatch
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-verify test -- verify-context-ecdsa`
Expected: FAIL — `makeVerifySignatureFromTrustRoot` not exported.

- [ ] **Step 3: Implement**

In `verify-context.ts`: import `resolveKey, type TrustRoot` from `./trust-root.js`; add `trustRoot?: TrustRoot` to both `VerifyContextJson` and `VerifyContext`; in `loadVerifyContext` pass `trustRoot: json.trustRoot` through. Add:

The callback is a THIN COMPOSITION of pure, separately-tested helpers — it reuses the `verifySignatureBytes` primitive from Task 4 (no re-inlined alg dispatch — DRY) and accepts an optional `verifiedGenTime` so the **key-lifecycle gate** (`keyUsableAt`, defined in Task 11) can be composed in without this function owning the policy. In Task 9 the gate is a no-op placeholder (`keyUsableAt` lands in Task 11); wire the param now so Task 11 is purely additive:

```ts
import { resolveKey, type TrustRoot, type TrustRootKey } from './trust-root.js';
// keyUsableAt is added by Task 11 (packages/pangolin-verify/src/revocation.ts); until then,
// import is added in Task 11. In Task 9, omit the keyUsableAt line and the verifiedGenTime param.

/** Verify callback resolving the pubkey by sig.keyRef from a published trust root.
 *  No trust root → undefined (core 'n/a'). keyRef unknown → false (hard fail). alg must
 *  match the published entry. Crypto goes through the shared verifySignatureBytes primitive.
 *  Composition only — resolution, lifecycle policy, and crypto are each separate pure fns. */
export function makeVerifySignatureFromTrustRoot(
  trustRoot: TrustRoot | undefined,
  verifiedGenTime?: Date,   // added in Task 9; CONSUMED by keyUsableAt in Task 11
): ((root: Uint8Array, sig: Signature) => boolean) | undefined {
  if (!trustRoot) return undefined;
  return (root, sig) => {
    const entry = resolveKey(trustRoot, sig.keyRef);
    if (!entry) return false;                 // unrecognized signer = hard fail
    if (entry.alg !== sig.alg) return false;  // alg must match the published entry
    // Task 11 inserts here: if (!keyUsableAt(entry, verifiedGenTime)) return false;
    let key: KeyObject;
    try {
      key = createPublicKey({ key: Buffer.from(entry.spkiDer, 'base64'), format: 'der', type: 'spki' });
    } catch {
      return false;                           // malformed base64 / SPKI
    }
    return verifySignatureBytes(sig.alg, root, key, sig.bytes);
  };
}
```
> Reuses `verifySignatureBytes` (Task 4) — the alg dispatch exists in exactly ONE place. `KeyObject` is already imported at `verify-context.ts:8`.

Then wire the caller (`cli.ts` and any other verify entry point): when `ctx.trustRoot` is set, the bundle-wiring layer first computes the verified genTime via `verifyTimestampWithTime` (Task 10) over the bundle's anchored-root token, then builds `makeVerifySignatureFromTrustRoot(ctx.trustRoot, verifiedGenTime)`; else it falls back to `makeVerifySignature(ctx)` (single-key shorthand). **Add a focused test for this caller selection** (trustRoot present → map path; absent → single-key path). Keep `makeVerifySignature` unchanged so existing single-key callers/tests pass.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-verify test`
Expected: PASS (all verify tests, including the untouched single-key path).

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-verify/src/verify-context.ts packages/pangolin-verify/test/verify-context-ecdsa.test.ts
git commit -m "feat(verify): resolve signer pubkey by keyRef from published trust root"
```

---

## Wave D — genTime prerequisite + revocation

### Task 10: surface verified `genTime` out of the timestamp verifier

**Files:**
- Modify: `packages/pangolin-verify/src/timestamp-authority.ts` (`verifyTimestamp`)
- Test: `packages/pangolin-verify/test/timestamp-gentime.test.ts` (create)

> SPEC §7.3 HARD PREREQUISITE. Today `verifyTimestamp` parses `genTime` (line 218) for its window checks then returns a bare `boolean`. Refactor: extract the body into an internal `verifyTimestampWithTime(root, token, certs): { ok: boolean; genTime?: Date }`; keep `verifyTimestamp` as a thin boolean wrapper (back-compat for `makeVerifyTimestamp` and all importers). Only surface `genTime` when `ok === true`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { LocalCaTimestampAuthority, verifyTimestamp, verifyTimestampWithTime } from '../src/timestamp-authority.js';

describe('verifyTimestampWithTime', () => {
  it('returns ok:true and the authoritative genTime for a valid token', async () => {
    const tsa = new LocalCaTimestampAuthority();
    const root = new Uint8Array(32).fill(11);
    const token = await tsa.timestamp(root);
    const r = verifyTimestampWithTime(root, token, [tsa.caCertDer]);
    expect(r.ok).toBe(true);
    expect(r.genTime instanceof Date).toBe(true);
    // boolean wrapper still agrees
    expect(verifyTimestamp(root, token, [tsa.caCertDer])).toBe(true);
  });
  it('returns ok:false and no genTime for an untrusted token', async () => {
    const tsa = new LocalCaTimestampAuthority();
    const root = new Uint8Array(32).fill(11);
    const token = await tsa.timestamp(root);
    const r = verifyTimestampWithTime(root, token, []); // no trust anchor
    expect(r.ok).toBe(false);
    expect(r.genTime).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-verify test -- timestamp-gentime`
Expected: FAIL — `verifyTimestampWithTime` not exported.

- [ ] **Step 3: Implement the refactor**

Rename the current `verifyTimestamp` body to an exported `verifyTimestampWithTime(root, token, trustedCerts): { ok: boolean; genTime?: Date }`. Change every `return false;` inside it to `return { ok: false };`, every `return true;` to `return { ok: true, genTime };` (the trust-anchor matches at the end of the function — `genTime` is in scope from line 218). The top-level `catch` returns `{ ok: false }`. Then:

```ts
/** Back-compat boolean wrapper (unchanged contract for makeVerifyTimestamp + importers). */
export function verifyTimestamp(root: Uint8Array, token: TimestampToken, trustedCerts: Uint8Array[]): boolean {
  return verifyTimestampWithTime(root, token, trustedCerts).ok;
}
```
> Net behavior of `verifyTimestamp` is identical; only a `genTime`-bearing sibling is added. Also add `verifyTimestampWithTime` to the verify barrel `packages/pangolin-verify/src/index.ts` (beside the existing `verifyTimestamp` re-export at `:13`) so the revocation wiring in Task 11 can import it from the package root.

- [ ] **Step 4: Run the FULL verify suite (the refactor touches a hot path)**

Run: `pnpm --filter @quarry-systems/pangolin-verify test`
Expected: PASS — all existing RFC-3161 tests (signed-attrs, EKU, window negatives) still green via the wrapper, plus the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-verify/src/timestamp-authority.ts packages/pangolin-verify/src/index.ts packages/pangolin-verify/test/timestamp-gentime.test.ts
git commit -m "feat(verify): surface verified genTime (verifyTimestampWithTime); verifyTimestamp stays boolean"
```

---

### Task 11: key-lifecycle gate (notBefore/notAfter + time-bounded revocation)

**Files:**
- Create: `packages/pangolin-verify/src/revocation.ts`
- Test: `packages/pangolin-verify/test/revocation.test.ts`

> SPEC §7. ONE lifecycle decision over (resolved entry, verified genTime), so `notBefore`/`notAfter` are actually enforced (not dead fields) alongside revocation:
> - `active` + within `[notBefore, notAfter]` → usable.
> - `revoked` → usable ONLY when a verified `tsa-attested` genTime proves signing strictly before `revokedAt`; missing verified genTime (asserted-only time) is hard-fail.
> - A window check (`notBefore`/`notAfter`) needs a verified genTime; with none, fall back to allow (the window is advisory when no trusted time exists — revocation is the hard control). This keeps the no-TSA path behaving exactly as today for active keys while making the windows real whenever trusted time IS present.
> Self-asserted chain time is operator-controllable and must NEVER be passed as `verifiedGenTime`. It composes with Task 9's resolution — a key that passes the gate still goes through the crypto check.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { keyUsableAt } from '../src/revocation.js';
import type { TrustRootKey } from '../src/trust-root.js';

const active: TrustRootKey = { alg: 'ecdsa-p256', spkiDer: 'x', status: 'active', notBefore: '2026-01-01T00:00:00Z', notAfter: null, revokedAt: null };
const windowed: TrustRootKey = { ...active, notBefore: '2026-03-01T00:00:00Z', notAfter: '2026-09-01T00:00:00Z' };
const revoked: TrustRootKey = { ...active, status: 'revoked', revokedAt: '2026-06-01T00:00:00Z' };

describe('keyUsableAt', () => {
  it('active, no verified time: usable (window advisory without trusted time)', () => {
    expect(keyUsableAt(active, undefined)).toBe(true);
  });
  it('active within window (verified time): usable', () => {
    expect(keyUsableAt(windowed, new Date('2026-05-01T00:00:00Z'))).toBe(true);
  });
  it('active before notBefore / after notAfter (verified time): NOT usable', () => {
    expect(keyUsableAt(windowed, new Date('2026-02-01T00:00:00Z'))).toBe(false);
    expect(keyUsableAt(windowed, new Date('2026-10-01T00:00:00Z'))).toBe(false);
  });
  it('revoked + no verified genTime (asserted only): hard-fail', () => {
    expect(keyUsableAt(revoked, undefined)).toBe(false);
  });
  it('revoked + verified genTime strictly before revokedAt: usable', () => {
    expect(keyUsableAt(revoked, new Date('2026-05-31T23:59:59Z'))).toBe(true);
  });
  it('revoked + verified genTime at/after revokedAt: fail', () => {
    expect(keyUsableAt(revoked, new Date('2026-06-01T00:00:00Z'))).toBe(false);
    expect(keyUsableAt(revoked, new Date('2026-06-02T00:00:00Z'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-verify test -- revocation`
Expected: FAIL — module/symbol missing.

- [ ] **Step 3: Implement**

```ts
import type { TrustRootKey } from './trust-root.js';

/** Parse a strict-ISO timestamp to epoch ms; the trust root was already validated by
 *  parseTrustRoot, but guard NaN defensively so a bad value fails closed, never opens. */
function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`keyUsableAt: unparseable timestamp ${iso}`);
  return t;
}

/** Spec §7: is this trust-root key usable for a signature whose VERIFIED signing time is
 *  `verifiedGenTime` (from a tsa-attested token; undefined when only asserted time exists)?
 *  - revoked: usable iff verified genTime proves signing strictly before revokedAt (else hard-fail).
 *  - active : usable; if a verified genTime exists, it must fall within [notBefore, notAfter].
 *    Without a verified genTime the window is advisory (revocation remains the hard control). */
export function keyUsableAt(entry: TrustRootKey, verifiedGenTime: Date | undefined): boolean {
  if (entry.status === 'revoked') {
    if (!entry.revokedAt || !verifiedGenTime) return false;   // no trusted proof of signing time
    return verifiedGenTime.getTime() < ms(entry.revokedAt);
  }
  // active
  if (!verifiedGenTime) return true;                          // window advisory without trusted time
  const t = verifiedGenTime.getTime();
  if (t < ms(entry.notBefore)) return false;
  if (entry.notAfter != null && t > ms(entry.notAfter)) return false;
  return true;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @quarry-systems/pangolin-verify test -- revocation`
Expected: PASS.

- [ ] **Step 5: Compose the gate into the keyRef verify path + integration test**

In `makeVerifySignatureFromTrustRoot` (Task 9), uncomment the composition line so the body reads, after the `alg !== sig.alg` check:
```ts
    if (!keyUsableAt(entry, verifiedGenTime)) return false;
```
(add `import { keyUsableAt } from './revocation.js';` to `verify-context.ts`). The callback now COMPOSES three pure, separately-tested helpers — `resolveKey` (lookup), `keyUsableAt` (lifecycle policy), `verifySignatureBytes` (crypto) — and owns none of their internals. The verified genTime is computed ONCE at the bundle-wiring layer (`verifyTimestampWithTime` over the bundle's anchored-root token) and injected; this is the §7.3 "obtain genTime at the bundle level, inject into the signature check" contract.

Add an integration test in `verify-context-ecdsa.test.ts`: a `revoked` keyRef with no genTime → callback returns false; an `active` keyRef + a `LocalCaTimestampAuthority` token (genTime ≈ now, within window) → true. (The local TSA stamps "now", so assert these realistic cases; the exact time-boundary is unit-covered in Step 1.)

Run: `pnpm --filter @quarry-systems/pangolin-verify test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/pangolin-verify/src/revocation.ts packages/pangolin-verify/src/verify-context.ts packages/pangolin-verify/test/revocation.test.ts packages/pangolin-verify/test/verify-context-ecdsa.test.ts
git commit -m "feat(verify): time-bounded revocation keyed on Signature.keyRef + verified genTime"
```

---

## Wave E — docs + wiring (documented, not wired into a live deployment)

### Task 12: trust-root publication reference + serve-stack wiring example

**Files:**
- Create: `docs-site/src/content/docs/reference/trust-root.md`
- Modify (example only): `deploy/serve-stack/client/pangolin.config.mjs`

- [ ] **Step 1: Write the reference doc**

Document: (1) the trust-root manifest JSON shape (from `trust-root.ts`); (2) how operators generate entries via `publishablePublicKey` against KMS `GetPublicKey`; (3) the publication channel (TLS docs site / signed committed file) and the **never-from-bundle** rule; (4) rotation cadence + revocation semantics incl. the trusted-time dependency; (5) the honesty bound — demo bundles state the key tier (local ephemeral) alongside the tamper tier.

- [ ] **Step 2: Add a documented (commented) ecdsa/trust-root wiring example**

In `deploy/serve-stack/client/pangolin.config.mjs`, add a commented block beside the existing `verifyEd25519` wiring showing how a production deployment would load a `trustRoot` manifest and use `makeVerifySignatureFromTrustRoot`. Leave the existing ed25519 wiring active (no behavior change).

- [ ] **Step 3: Verify the docs site builds**

Run: `pnpm --filter @pangolin/docs-site build` (the docs-site package is `@pangolin/docs-site`, build script `astro build` — note the `@pangolin/*` scope, not `@quarry-systems/*`).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs-site/src/content/docs/reference/trust-root.md deploy/serve-stack/client/pangolin.config.mjs
git commit -m "docs(seal): trust-root publication format + production wiring example"
```

> **Out-of-repo follow-up (not a code task):** on promotion, correct the vault decision page `decision-2026-06-15-seal-signing-key-custody-demo-local` §2.1 premise (AWS KMS *does* now support Ed25519; ECDSA-P256 chosen for portability) — edit via the vault MCP/Edit tools, never Get-Content/Set-Content.

---

## Final task: full gate

- [ ] **Step 1: Fresh-worktree build (avoid stale-dist false failures)**

Run: `pnpm install && pnpm -r build`
Expected: clean build across the workspace (new package included).

- [ ] **Step 2: Run the FULL gate** (per repeated CI lessons — root e2e is a SEPARATE job not in `pnpm -r test`)

Run:
```bash
pnpm -r typecheck
pnpm -r test
pnpm test:e2e
pnpm -r lint
```
Expected: all PASS. If a `VerificationReport` literal or a signature-outcome assertion broke, fix the fixture to legitimately satisfy the new rule (publish the test key in a test manifest) — NEVER loosen a security assertion.

- [ ] **Step 3: Confirm the SDK isolation invariant**

Run: `git grep -l "@aws-sdk/client-kms" packages/`
Expected: ONLY `packages/pangolin-signer-aws-kms/**`. `pangolin-core` and `pangolin-verify` must NOT appear.

- [ ] **Step 4: Final commit (if any fixture fixes were needed)**

```bash
git add -A && git commit -m "test(seal): satisfy ecdsa-p256/trust-root rules across the full gate"
```

---

## Self-review notes (spec coverage)

- Spec §1 ECDSA path → Tasks 1–4 (alg dispatch written once as `verifySignatureBytes` — DRY). §2 KMS leaf signer → Tasks 5–7 (copy `aws-creds` verbatim, CJS, `@aws-sdk/client-kms ^3.700.0`). §3 trust root → Tasks 8–9 (incl. strict `parseTrustRoot` validator). §4 lifecycle (window + revocation) → Tasks 10–11 (genTime prerequisite sequenced first; `notBefore`/`notAfter` enforced by `keyUsableAt`, not dead fields). §1.1/§6.3 honesty + publication → Task 12. §8 blast radius / full gate → Final task. §10 acceptance #1–9 each exercised by a test above (#6 revocation positive case gated behind Task 10, per spec §7.3).
- Type consistency: `Signature.alg` value `'ecdsa-p256'`, `verifyEcdsaP256`, `createLocalEcdsaSigner`, `createKmsSigner`, `publishablePublicKey`, `TrustRoot`/`TrustRootKey`/`resolveKey`/`parseTrustRoot`, `verifySignatureBytes`, `makeVerifySignatureFromTrustRoot`, `verifyTimestampWithTime`, `keyUsableAt` are used consistently across tasks (note: the revocation fn is `keyUsableAt`, NOT the earlier `signatureAllowedUnderRevocation`).
- No `VerificationReport` field is added (kept optional/none per spec §8); the alg dispatch lives in exactly one primitive; the trust-root callback composes three pure helpers (SRP).

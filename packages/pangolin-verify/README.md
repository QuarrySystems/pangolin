# @quarry-systems/pangolin-verify

Standalone verifier for Pangolin Scale audit bundles — the artifact an auditor runs to confirm a sealed run was not tampered with, *without* installing the orchestrator that produced it. It owns the RFC 3161 / ASN.1 (`pkijs`) dependency so `@quarry-systems/pangolin-core` stays dependency-light, and supplies the ed25519 and trusted-time (RFC 3161) verifier callbacks that `pangolin-core`'s `verifyBundle` injects. Run `pangolin-verify bundle.json [--anchor verify-context.json]`; see [`VERIFICATION.md`](https://github.com/QuarrySystems/pangolin/blob/main/VERIFICATION.md) for the bundle format and algorithm.

```bash
pnpm add @quarry-systems/pangolin-verify
```

Part of [pangolin](https://quarrysystems.github.io/pangolin).

License: BUSL-1.1

<!--
DRAFT — launch / blog / Show HN write-up for agora. Also serves as the
narration script for the 60–90s terminal demo. Replace [contact / repo]
before publishing. Deliberately under-claims (the Bedrock-policy "deny"
layer is roadmap) — that honesty is what earns builder trust.
Drafted 2026-05-27.
-->

# Your AI agent has your shell, your keys, and your filesystem. Mine doesn't.

Most "autonomous agent" setups have a security model that's basically: *trust the model.* The agent runs in your process, with your environment — your `ANTHROPIC_API_KEY`, your AWS creds, your filesystem, your shell. We hand a non-deterministic text generator ambient access to everything and hope the prompt holds.

I kept seeing the same non-fix: *"add an authorization check as a tool the agent calls."* But think about what that is — the agent is both the thing being governed **and** the thing deciding whether to consult the governor. It can skip the call or ignore the "no." That's advisory, not enforcement. Real access control has to live somewhere the agent **can't route around it** — in the execution boundary, not in the agent's own toolbox.

So I built **agora**: a runtime that dispatches each agent into a throwaway sandbox with **only** the capabilities and secrets you grant at dispatch time — and keeps the privileged controls out of the agent's reach entirely.

## What that looks like

You (the operator) register what an agent *is* and *gets*. Then you dispatch it:

```ts
await client.capabilities.register({ name: 'echo-cap', files: { 'agora-setup.sh': '…' } });
await client.subagent.register({ name: 'echo', capabilities: ['echo-cap'] });
await client.env.register({ name: 'minimal', values: { LOG_LEVEL: 'info' } });

const result = await client.dispatch({ subagent: 'echo', env: 'minimal', target: 'local', workerImage: '…' });
```

The agent runs in a fresh container that has the granted capability files and the granted env — **nothing else.** No ambient shell, no inherited keys, no host filesystem. And the result is content-hash audited:

```text
=== resolved ===
{ "subagent":     { "name": "echo",     "contentHash": "sha256:d6f7…" },
  "capabilities": [{ "name": "echo-cap", "contentHash": "sha256:2033…" }],
  "env":          [{ "name": "minimal",  "contentHash": "sha256:766c…" }] }
=== stdout ===
{"kind":"worker.boot",...}
{"kind":"setup-script.ran","exitCode":0,"stdout":"hello from agora-worker\n"}
{"kind":"dispatch.finished","exitCode":0}
```

Those hashes are a provable record of exactly which bytes ran — the audit trail `name`-only identity can't give you once a registry allows updates.

## The part that makes it unbypassable

The agent's own tool surface (the MCP server it talks to) exposes **run-time tools only**. The privileged operations — `register`, `assign`: granting an agent more capabilities — are **CLI-only, operator-side, and never reach the AI loop.** The agent cannot grant itself more access, because the verb to do so isn't in its hands. Enforcement lives at the boundary, not in the agent's good behavior.

Same code path runs locally against Docker and in production against Fargate + S3 — the swap is constructor-only.

## What's *not* done yet (because honesty is the point)

This is v0.1. Today agora enforces access by **grant-scoping + operator-only control + sandbox isolation + audit.** The next layer — a policy engine that *denies a specific action* an agent attempts, with on-behalf-of delegation — is wired but not shipped. I'm not going to show you a denial I haven't built. The execution sandbox is real today; the fine-grained policy is the roadmap.

## If you run agents

If you're running autonomous or long-running agents and you've felt the *"this thing has way too much access and I can't prove what it did"* itch — I'd genuinely like to set agora up around your agent, for free, and hear where it falls short. [contact / repo]

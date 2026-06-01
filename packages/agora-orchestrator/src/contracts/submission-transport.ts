import type { Run } from './types.js';

/** A client submission: the plan plus who submitted it (identity primitive — not authz). */
export interface SubmissionEnvelope {
  run: Run;
  actor: string;        // e.g. "human:brett" | "agent:<id>"
  submittedAt: string;  // ISO-8601
}

export const OUTBOX_KINDS = ['status', 'completed', 'audit'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** A privileged control request (cancel in V1). Identity-stamped, never authz. */
export interface ControlEnvelope {
  kind: 'cancel';
  target: string;       // run-id or item-id
  actor: string;        // "human:<id>" — recorded on the audit entry
  at: string;           // ISO-8601
}

/** Optional capability a transport MAY also implement — the cancel path. Kept
 *  separate from SubmissionTransport so existing impls/fakes are unaffected. */
export interface ControlChannel {
  control(env: ControlEnvelope): Promise<void>;          // client → control inbox
  pollControl(): Promise<ControlEnvelope[]>;             // service: claim control requests
  ackControl(target: string): Promise<void>;             // service: consume one
}

export interface OutboxRecord {
  runId: string;
  kind: OutboxKind;
  body: unknown;        // status tree or completion summary
  at: string;           // ISO-8601
}

/** Inbox/outbox over a prefix convention. No inbound networking: the service polls, never listens. */
export interface SubmissionTransport {
  submit(env: SubmissionEnvelope): Promise<string>;   // client → inbox; returns run id
  pollInbox(): Promise<SubmissionEnvelope[]>;          // service: claim new, un-ingested submissions
  ack(runId: string): Promise<void>;                   // consume (delete) an ingested submission
  deadLetter(runId: string): Promise<void>;            // quarantine an un-ingestable submission
  publish(rec: OutboxRecord): Promise<void>;           // service → outbox
  readOutbox(runId: string): Promise<OutboxRecord[]>;  // client: read status/completion
}

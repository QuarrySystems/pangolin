// Channel adapter contract (§5.7).
//
// A `ChannelAdapter` is a pluggable transport for the coordination
// channels described in the design (e.g. vault channels, Slack, a SQL
// table polled on an interval). It is intentionally minimal: a name, and
// a `subscribe` that returns an async iterable of messages.
//
// Adapters own backoff, reconnection, and cursor management internally.
// Callers iterate; the runtime does not pass cursors back through this
// interface.

/**
 * Configuration for a single subscription. `channel` is the human-meaningful
 * channel identifier (e.g. `feat-stadium-readiness-progress`); `opts` is an
 * adapter-specific bag (auth tokens, polling intervals, filter expressions).
 */
export interface ChannelConfig {
  channel: string;
  opts?: Record<string, unknown>;
}

/**
 * A single message received on a channel. `id` is opaque and adapter-defined
 * but must be unique within the channel. `ts` is an ISO-8601 timestamp.
 */
export interface ChannelMessage {
  id: string;
  body: string;
  ts: string;
}

export interface ChannelAdapter {
  readonly name: string;
  subscribe(config: ChannelConfig): AsyncIterable<ChannelMessage>;
}

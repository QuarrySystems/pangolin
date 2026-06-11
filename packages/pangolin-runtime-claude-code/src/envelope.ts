import type { RuntimeUsage } from '@quarry-systems/pangolin-core';

export interface ParsedEnvelope {
  /** Agent text, normalized to end with at least one trailing \n (never double-appended) —
   *  matching what raw `claude --print` stdout carries for the same content. */
  text: string;
  usage?: RuntimeUsage;
}

/** Best-effort parse. Non-JSON / wrong-shape stdout => { text: rawStdout } verbatim (no normalization —
 *  raw mode IS the fallback), usage absent. */
export function parseClaudeEnvelope(rawStdout: string): ParsedEnvelope {
  try {
    const env = JSON.parse(rawStdout) as Record<string, unknown>;
    if (typeof env.result !== 'string') return { text: rawStdout };
    const text = env.result.endsWith('\n') ? env.result : env.result + '\n';
    const models = env.modelUsage && typeof env.modelUsage === 'object' ? Object.keys(env.modelUsage) : [];
    const usage: RuntimeUsage = { models };
    if (typeof env.total_cost_usd === 'number') usage.costUsd = env.total_cost_usd;
    if (typeof env.num_turns === 'number') usage.turns = env.num_turns;
    if (typeof env.duration_ms === 'number') usage.durationMs = env.duration_ms;
    return { text, usage };
  } catch {
    return { text: rawStdout };
  }
}

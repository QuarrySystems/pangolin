import { parseClaudeEnvelope } from '../src/envelope.js';
import { it, expect } from 'vitest';

it('extracts text with a trailing newline and usage from a well-formed envelope', () => {
  const raw = JSON.stringify({ result: 'ok', modelUsage: { 'claude-opus-4-7': {} }, total_cost_usd: 0.05, num_turns: 1, duration_ms: 1175 });
  const p = parseClaudeEnvelope(raw);
  expect(p.text).toBe('ok\n');
  expect(p.usage).toEqual({ models: ['claude-opus-4-7'], costUsd: 0.05, turns: 1, durationMs: 1175 });
});

it('does not double-append newline when result already ends with one', () => {
  const raw = JSON.stringify({ result: 'done\n', modelUsage: {}, total_cost_usd: 0.01, num_turns: 2, duration_ms: 500 });
  const p = parseClaudeEnvelope(raw);
  expect(p.text).toBe('done\n');
});

it('tolerates missing modelUsage - models is empty array, scalars still captured', () => {
  const raw = JSON.stringify({ result: 'hello', total_cost_usd: 0.02, num_turns: 3, duration_ms: 300 });
  const p = parseClaudeEnvelope(raw);
  expect(p.text).toBe('hello\n');
  expect(p.usage).toEqual({ models: [], costUsd: 0.02, turns: 3, durationMs: 300 });
});

it('tolerates missing scalars - usage has only models', () => {
  const raw = JSON.stringify({ result: 'hi', modelUsage: { 'claude-haiku': {} } });
  const p = parseClaudeEnvelope(raw);
  expect(p.text).toBe('hi\n');
  expect(p.usage).toEqual({ models: ['claude-haiku'] });
});

it('falls back to verbatim text with no usage for non-JSON stdout', () => {
  const raw = 'not json at all';
  const p = parseClaudeEnvelope(raw);
  expect(p.text).toBe('not json at all');
  expect(p.usage).toBeUndefined();
});

it('falls back to verbatim text with no usage for JSON without string result', () => {
  const raw = JSON.stringify({ foo: 'bar', result: 42 });
  const p = parseClaudeEnvelope(raw);
  expect(p.text).toBe(raw);
  expect(p.usage).toBeUndefined();
});

it('falls back to verbatim text with no usage for JSON with no result field', () => {
  const raw = JSON.stringify({ cost: 0.1 });
  const p = parseClaudeEnvelope(raw);
  expect(p.text).toBe(raw);
  expect(p.usage).toBeUndefined();
});

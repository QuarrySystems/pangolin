import { it, expect } from 'vitest';

import { buildDispatchRecordUri, parsePangolinUri } from '../src/uri.js';

it('builds the canonical dispatch-record URI', () => {
  expect(buildDispatchRecordUri('my-org', 'd-123')).toBe(
    'pangolin://my-org/dispatches/d-123',
  );
});

it('builds with an explicit suffix', () => {
  expect(buildDispatchRecordUri('my-org', 'd-123', 'record.json')).toBe(
    'pangolin://my-org/dispatches/d-123/record.json',
  );
});

it('rejects invalid namespace or dispatchId', () => {
  expect(() => buildDispatchRecordUri('', 'd')).toThrow();
  expect(() => buildDispatchRecordUri('o/x', 'd')).toThrow();
  expect(() => buildDispatchRecordUri('o', '')).toThrow();
  expect(() => buildDispatchRecordUri('o', 'd/x')).toThrow();
});

it('rejects invalid suffix (empty string or containing //)', () => {
  expect(() => buildDispatchRecordUri('o', 'd', '')).toThrow();
  expect(() => buildDispatchRecordUri('o', 'd', 'a//b')).toThrow();
});

it('parsePangolinUri still rejects type=dispatches (safety property preserved)', () => {
  // The general parser must still reject — only the dedicated helper is
  // allowed to construct URIs under the reserved `dispatches/` prefix.
  expect(() =>
    parsePangolinUri('pangolin://my-org/dispatches/d-123/record.json'),
  ).toThrow();
});

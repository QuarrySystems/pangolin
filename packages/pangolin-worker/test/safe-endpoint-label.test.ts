import { describe, it, expect } from 'vitest';
import { safeEndpointLabel } from '../src/safe-endpoint-label.js';

describe('safeEndpointLabel', () => {
  it('strips userinfo, path, and query, returning only the origin', () => {
    expect(safeEndpointLabel('https://u:p@h.example.com/a?t=1', 0)).toBe('https://h.example.com');
  });

  it('preserves a non-default port', () => {
    expect(safeEndpointLabel('http://h:8080/x', 0)).toBe('http://h:8080');
  });

  it.each(['not-a-url', '', '//example.com/x', 'file:///etc/passwd', 'data:text/plain,hi'])(
    "never throws and never returns the literal 'null' origin for %j",
    (bad) => {
      expect(safeEndpointLabel(bad, 2)).toBe('notification[2] <unparseable>');
    },
  );

  it('includes the given index in the fallback label', () => {
    expect(safeEndpointLabel('not-a-url', 7)).toBe('notification[7] <unparseable>');
  });

  it.each([undefined, null, 42, {}])(
    'is total for non-string input %j that JSON.parse can produce',
    (bad) => {
      expect(safeEndpointLabel(bad as unknown as string, 4)).toBe('notification[4] <unparseable>');
    },
  );

  describe('never leaks credentials or query params', () => {
    const cases: Array<[string, number]> = [
      ['https://u:p@h.example.com/a?t=1', 0],
      ['http://h:8080/x', 0],
      ['not-a-url', 2],
      ['', 2],
      ['//example.com/x', 2],
      ['file:///etc/passwd', 2],
      ['data:text/plain,hi', 2],
    ];

    it.each(cases)('label for %j contains no @ or ? characters', (input, index) => {
      const label = safeEndpointLabel(input, index);
      expect(label).not.toContain('@');
      expect(label).not.toContain('?');
    });
  });
});

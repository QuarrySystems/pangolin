import { splitFrontmatter } from '../src/frontmatter.js';
import { describe, it, expect } from 'vitest';

describe('splitFrontmatter', () => {
  it('parses basic frontmatter + body', () => {
    const r = splitFrontmatter('---\nname: x\nmodel: claude-sonnet-4-6\n---\nthe body\n');
    expect(r.frontmatter).toEqual({ name: 'x', model: 'claude-sonnet-4-6' });
    expect(r.body).toBe('the body');
  });

  it('preserves multi-line body and trims surrounding whitespace', () => {
    const r = splitFrontmatter('---\nname: x\n---\n\nline one\nline two\n\n');
    expect(r.body).toBe('line one\nline two');
  });

  it('handles CRLF line endings', () => {
    const r = splitFrontmatter('---\r\nname: x\r\n---\r\nbody\r\n');
    expect(r.frontmatter).toEqual({ name: 'x' });
    expect(r.body).toBe('body');
  });

  it('returns empty frontmatter object for an empty block', () => {
    const r = splitFrontmatter('---\n\n---\nbody only\n');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('body only');
  });

  it('throws when no frontmatter delimiters are present', () => {
    expect(() => splitFrontmatter('no frontmatter here\njust body\n')).toThrow(
      /no YAML frontmatter found/,
    );
  });
});

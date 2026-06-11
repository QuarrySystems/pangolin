// Shared frontmatter splitter used by the sync commands.
//
// Parses a file that opens with `---\n<yaml>\n---\n<body>` and returns the
// parsed frontmatter object plus the body string. Throws when the leading
// `---` delimiter is absent so the sync command can surface a clear error
// per file rather than silently treating the whole file as a body.

import { parse as parseYaml } from 'yaml';

export interface SplitResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontmatter(raw: string): SplitResult {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error('no YAML frontmatter found (expected `---` delimiters)');
  }
  const frontmatter = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  const body = match[2].replace(/^\s+/, '').replace(/\s+$/, '');
  return { frontmatter, body };
}

// Claude Code sync provider.
//
// Subagents: `.claude/agents/<name>.md` — YAML frontmatter (name, model,
// description, tools, ...) + markdown body. The body becomes the Pangolin Scale
// subagent's `systemPrompt`; `model` carries through; `description` and
// `tools` have no pangolin equivalent and are dropped (tools = Claude Code
// tool grants, not file bundles).
//
// Capabilities: `.claude/skills/<name>/` — a directory tree containing
// SKILL.md and any supporting files. We bundle the tree directly at
// `.claude/skills/<name>/<rel-path>` so the overlay engine writes it into
// the worker's workspace at that same path; the claude-code runtime
// adapter declares `.claude/skills/**` as a reserved path and `claude` is
// spawned with `cwd: workspaceDir`, so the binary discovers the bundled
// content natively as project-level skills. NO setup script is generated:
// `pangolin-setup.sh` is a single-slot `last-write-wins` file (overlay-engine
// PANGOLIN_MANIFEST_RULES), so synthesizing one per capability would collide
// on multi-capability dispatches — only the last would actually run.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { splitFrontmatter } from '../frontmatter.js';
import type { CapabilityBundle, SubagentDef, SyncProvider } from './types.js';

export class ClaudeCodeProvider implements SyncProvider {
  readonly name = 'claude-code';
  readonly defaultSubagentDir = '.claude/agents';
  readonly defaultCapabilityDir = '.claude/skills';

  async loadSubagents(dir: string): Promise<SubagentDef[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const mdFiles = entries.filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.md');
    const defs: SubagentDef[] = [];
    for (const e of mdFiles) {
      const path = join(dir, e.name);
      const raw = await readFile(path, 'utf8');
      const { frontmatter, body } = splitFrontmatter(raw);
      const name =
        typeof frontmatter.name === 'string' && frontmatter.name.length > 0
          ? frontmatter.name
          : basename(e.name, '.md');
      const def: SubagentDef = { name, systemPrompt: body };
      if (typeof frontmatter.model === 'string') def.model = frontmatter.model;
      defs.push(def);
    }
    return defs;
  }

  async loadCapabilities(dir: string): Promise<CapabilityBundle[]> {
    // Walk recursively looking for `SKILL.md` markers. The containing
    // directory of each marker is one skill — name = its basename, bundle =
    // its full contents. Once we find a SKILL.md we do NOT recurse further
    // into that skill (so a skill's own `references/foo/SKILL.md` would not
    // be double-registered as a sibling). This makes the provider
    // layout-agnostic: flat (`<dir>/<skill>/SKILL.md`), nested
    // (`<dir>/<group>/<skill>/SKILL.md`), and deeper layouts all work.
    const skillDirs: string[] = [];
    await findSkillDirs(dir, skillDirs);

    const built: BuiltBundle[] = [];
    for (const skillRoot of skillDirs) {
      const name = basename(skillRoot);
      const files: Record<string, Uint8Array> = {};
      await walkInto(skillRoot, skillRoot, (rel, bytes) => {
        files[`.claude/skills/${name}/${rel}`] = bytes;
      });
      built.push({ name, path: skillRoot, files, hash: hashFiles(files) });
    }

    return dedupeByContent(built);
  }
}

interface BuiltBundle {
  name: string;
  path: string;
  files: Record<string, Uint8Array>;
  hash: string;
}

/**
 * Collapse same-name bundles. Identical-content duplicates (same name AND
 * same hash) are silently kept once — common when a sync upstream of Pangolin Scale
 * fans the same skill source into multiple grouping folders. Different-
 * content collisions (same name, divergent hashes) emit a warning and the
 * last-seen variant wins, matching prior "last registration wins" semantics
 * but only for the genuinely-ambiguous case.
 */
function dedupeByContent(built: BuiltBundle[]): CapabilityBundle[] {
  const byName = new Map<string, BuiltBundle[]>();
  for (const b of built) {
    const list = byName.get(b.name);
    if (list) list.push(b);
    else byName.set(b.name, [b]);
  }

  const out: CapabilityBundle[] = [];
  for (const [name, list] of byName) {
    const distinctHashes = new Set(list.map((b) => b.hash));
    if (distinctHashes.size === 1) {
      const first = list[0];
      out.push({ name: first.name, files: first.files });
      continue;
    }
    const paths = list.map((b) => b.path).join(', ');
    console.warn(
      `warn: skill name collision '${name}' across ${list.length} paths with DIFFERENT content — last wins (${paths})`,
    );
    const last = list[list.length - 1];
    out.push({ name: last.name, files: last.files });
  }
  return out;
}

/**
 * Deterministic SHA-256 over a file map: sorted keys, then `key\0bytes\0`
 * for each entry. Stable across runs and platforms — two file maps with the
 * same keys and same byte content always hash identically.
 */
function hashFiles(files: Record<string, Uint8Array>): string {
  const h = createHash('sha256');
  for (const key of Object.keys(files).sort()) {
    h.update(key);
    h.update(SEP);
    h.update(files[key]);
    h.update(SEP);
  }
  return h.digest('hex');
}

const SEP = Buffer.from([0]);

/**
 * Recursively descend `dir`, pushing any directory containing a `SKILL.md`
 * onto `out`. Stops descending into a directory once it qualifies as a
 * skill (nested SKILL.md inside an outer skill's tree is treated as part of
 * the outer skill, not its own skill).
 *
 * Skips dotfile directories (`.git`, `.cache`, etc.) so noise in the source
 * tree never sneaks into a bundle.
 */
async function findSkillDirs(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const hasSkillMarker = entries.some((e) => e.isFile() && e.name === 'SKILL.md');
  if (hasSkillMarker) {
    out.push(dir);
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      await findSkillDirs(join(dir, e.name), out);
    }
  }
}

/**
 * Walk `dir` recursively and invoke `visit(relativePath, bytes)` for every
 * file. Path separators are normalized to forward slashes so the bundle is
 * byte-identical across Windows and POSIX.
 */
async function walkInto(
  rootDir: string,
  dir: string,
  visit: (rel: string, bytes: Uint8Array) => void,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkInto(rootDir, full, visit);
    } else if (e.isFile()) {
      const rel = relative(rootDir, full).replace(/\\/g, '/');
      visit(rel, await readFile(full));
    }
  }
}


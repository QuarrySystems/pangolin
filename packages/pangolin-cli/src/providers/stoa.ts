// Stoa sync provider.
//
// Stoa organizes Claude Code content with a pokemon convention:
//   .claude/agents/profile-<pokemon>.md     ← agent system prompt
//   .claude/skills/<pokemon>/_pokemon.json  ← profile manifest (moves list)
//   .claude/skills/<pokemon>/<move>/SKILL.md ← each move is a skill
//
// The capability side is structurally identical to Claude Code — SKILL.md
// is the marker either way — so loadCapabilities just delegates to the
// ClaudeCodeProvider walk. What stoa adds is profile↔move binding:
// loadSubagents reads `_pokemon.json` to discover which moves belong to
// each pokemon, finds the matching agent file for the prompt, and emits a
// SubagentDef with `capabilities` pre-populated. That eliminates the
// "register caps → manually re-register subagent with bindings" step.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { splitFrontmatter } from '../frontmatter.js';
import { ClaudeCodeProvider } from './claude-code.js';
import type { CapabilityBundle, SubagentDef, SyncProvider } from './types.js';

const SKILLS_SUBDIR = '.claude/skills';
const AGENTS_SUBDIR = '.claude/agents';
const POKEMON_MANIFEST = '_pokemon.json';

interface PokemonManifest {
  pokemon_id?: unknown;
  moves?: unknown;
}

export class StoaProvider implements SyncProvider {
  readonly name = 'stoa';
  readonly defaultSubagentDir = '.';
  readonly defaultCapabilityDir = SKILLS_SUBDIR;

  private readonly claudeCode = new ClaudeCodeProvider();

  async loadSubagents(repoRoot: string): Promise<SubagentDef[]> {
    const skillsRoot = join(repoRoot, SKILLS_SUBDIR);
    const agentsRoot = join(repoRoot, AGENTS_SUBDIR);

    const pokemonDirs = await safeReaddir(skillsRoot);
    const defs: SubagentDef[] = [];
    for (const e of pokemonDirs) {
      if (!e.isDirectory()) continue;
      const manifest = await tryReadManifest(join(skillsRoot, e.name, POKEMON_MANIFEST));
      if (!manifest) continue;

      const pokemonId = typeof manifest.pokemon_id === 'string' ? manifest.pokemon_id : null;
      if (!pokemonId) {
        console.warn(
          `warn: ${join(skillsRoot, e.name, POKEMON_MANIFEST)} has no string 'pokemon_id' — skipping`,
        );
        continue;
      }
      const moves = Array.isArray(manifest.moves)
        ? manifest.moves.filter((m): m is string => typeof m === 'string')
        : [];

      const agentFile = join(agentsRoot, `${pokemonId}.md`);
      const agentSource = await tryReadFile(agentFile);
      if (agentSource === null) {
        console.warn(`warn: no agent file for '${pokemonId}' at ${agentFile} — skipping`);
        continue;
      }
      const { frontmatter, body } = splitFrontmatter(agentSource);

      const def: SubagentDef = {
        name: pokemonId,
        systemPrompt: body,
        capabilities: moves,
      };
      if (typeof frontmatter.model === 'string') def.model = frontmatter.model;
      defs.push(def);
    }
    return defs;
  }

  async loadCapabilities(dir: string): Promise<CapabilityBundle[]> {
    return this.claudeCode.loadCapabilities(dir);
  }
}

/** Read a directory, returning `[]` instead of throwing when it does not exist. */
async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Read and JSON-parse a file, returning null on missing/unparseable. */
async function tryReadManifest(path: string): Promise<PokemonManifest | null> {
  const raw = await tryReadFile(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PokemonManifest;
  } catch {
    console.warn(`warn: ${path} is not valid JSON — skipping`);
    return null;
  }
}

async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

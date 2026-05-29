import { StoaProvider } from '../../src/providers/stoa.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('StoaProvider', () => {
  let repoRoot: string;
  let provider: StoaProvider;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'agora-stoa-provider-'));
    provider = new StoaProvider();
  });

  describe('loadSubagents', () => {
    it('reads _pokemon.json + matching agent file and binds moves as capabilities', async () => {
      await mkdir(join(repoRoot, '.claude', 'agents'), { recursive: true });
      await mkdir(join(repoRoot, '.claude', 'skills', 'abra'), { recursive: true });
      await writeFile(
        join(repoRoot, '.claude', 'agents', 'profile-abra.md'),
        '---\nname: profile-abra\nmodel: claude-sonnet-4-6\n---\nYou are abra.\n',
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.claude', 'skills', 'abra', '_pokemon.json'),
        JSON.stringify({
          pokemon_id: 'profile-abra',
          moves: ['move-tdd-cycle', 'move-codemap'],
        }),
        'utf8',
      );

      const [def] = await provider.loadSubagents(repoRoot);
      expect(def).toEqual({
        name: 'profile-abra',
        systemPrompt: 'You are abra.',
        model: 'claude-sonnet-4-6',
        capabilities: ['move-tdd-cycle', 'move-codemap'],
      });
    });

    it('returns one SubagentDef per pokemon manifest found', async () => {
      await mkdir(join(repoRoot, '.claude', 'agents'), { recursive: true });
      await mkdir(join(repoRoot, '.claude', 'skills', 'abra'), { recursive: true });
      await mkdir(join(repoRoot, '.claude', 'skills', 'bulbasaur'), { recursive: true });
      for (const id of ['profile-abra', 'profile-bulbasaur']) {
        await writeFile(
          join(repoRoot, '.claude', 'agents', `${id}.md`),
          `---\nname: ${id}\n---\nbody\n`,
          'utf8',
        );
      }
      await writeFile(
        join(repoRoot, '.claude', 'skills', 'abra', '_pokemon.json'),
        JSON.stringify({ pokemon_id: 'profile-abra', moves: ['m1'] }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.claude', 'skills', 'bulbasaur', '_pokemon.json'),
        JSON.stringify({ pokemon_id: 'profile-bulbasaur', moves: ['m1', 'm2'] }),
        'utf8',
      );

      const defs = await provider.loadSubagents(repoRoot);
      expect(defs.map((d) => d.name).sort()).toEqual(['profile-abra', 'profile-bulbasaur']);
      const bulba = defs.find((d) => d.name === 'profile-bulbasaur')!;
      expect(bulba.capabilities).toEqual(['m1', 'm2']);
    });

    it('warns and skips a pokemon when its agent file is missing', async () => {
      await mkdir(join(repoRoot, '.claude', 'agents'), { recursive: true });
      await mkdir(join(repoRoot, '.claude', 'skills', 'orphan'), { recursive: true });
      await writeFile(
        join(repoRoot, '.claude', 'skills', 'orphan', '_pokemon.json'),
        JSON.stringify({ pokemon_id: 'profile-orphan', moves: [] }),
        'utf8',
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const defs = await provider.loadSubagents(repoRoot);
      expect(defs).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/no agent file for 'profile-orphan'/));
    });

    it('warns and skips a manifest with no pokemon_id', async () => {
      await mkdir(join(repoRoot, '.claude', 'skills', 'broken'), { recursive: true });
      await writeFile(
        join(repoRoot, '.claude', 'skills', 'broken', '_pokemon.json'),
        JSON.stringify({ moves: [] }),
        'utf8',
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const defs = await provider.loadSubagents(repoRoot);
      expect(defs).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/no string 'pokemon_id'/));
    });

    it('ignores pokemon dirs that have no _pokemon.json', async () => {
      await mkdir(join(repoRoot, '.claude', 'skills', 'not-a-pokemon'), { recursive: true });
      await writeFile(
        join(repoRoot, '.claude', 'skills', 'not-a-pokemon', 'SKILL.md'),
        'just a regular skill',
        'utf8',
      );

      const defs = await provider.loadSubagents(repoRoot);
      expect(defs).toEqual([]);
    });

    it('returns [] when .claude/skills does not exist', async () => {
      const defs = await provider.loadSubagents(repoRoot);
      expect(defs).toEqual([]);
    });
  });

  describe('loadCapabilities', () => {
    it('delegates to ClaudeCodeProvider walk (SKILL.md based)', async () => {
      const skillsDir = join(repoRoot, 'skills');
      await mkdir(join(skillsDir, 'abra', 'move-x'), { recursive: true });
      await writeFile(join(skillsDir, 'abra', '_pokemon.json'), '{}', 'utf8');
      await writeFile(join(skillsDir, 'abra', 'move-x', 'SKILL.md'), 'body', 'utf8');

      const bundles = await provider.loadCapabilities(skillsDir);
      expect(bundles.map((b) => b.name)).toEqual(['move-x']);
      // Files placed at .claude/skills/<name>/ for the adapter's reserved
      // path to pick up — no setup script (would collide on multi-cap).
      expect(Object.keys(bundles[0].files)).toEqual(['.claude/skills/move-x/SKILL.md']);
      expect(bundles[0].files['agora-setup.sh']).toBeUndefined();
    });
  });
});

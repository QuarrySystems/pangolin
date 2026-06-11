import { ClaudeCodeProvider } from '../../src/providers/claude-code.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('ClaudeCodeProvider', () => {
  let root: string;
  let provider: ClaudeCodeProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pangolin-cc-provider-'));
    provider = new ClaudeCodeProvider();
  });

  describe('loadSubagents', () => {
    it('parses frontmatter + body into name / systemPrompt / model', async () => {
      const dir = join(root, 'agents');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'code-reviewer.md'),
        '---\nname: code-reviewer\nmodel: claude-sonnet-4-6\ndescription: ignored\n---\nReview the code carefully.\n',
        'utf8',
      );
      await writeFile(
        join(dir, 'greeter.md'),
        '---\nname: greeter\n---\nSay hello and exit.\n',
        'utf8',
      );

      const defs = await provider.loadSubagents(dir);
      expect(defs).toHaveLength(2);
      const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
      expect(byName['code-reviewer']).toEqual({
        name: 'code-reviewer',
        systemPrompt: 'Review the code carefully.',
        model: 'claude-sonnet-4-6',
      });
      expect(byName['greeter']).toEqual({
        name: 'greeter',
        systemPrompt: 'Say hello and exit.',
      });
    });

    it('falls back to filename stem when frontmatter `name` is absent', async () => {
      const dir = join(root, 'agents');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'helper.md'), '---\nmodel: x\n---\nbody\n', 'utf8');
      const [def] = await provider.loadSubagents(dir);
      expect(def.name).toBe('helper');
    });

    it('ignores non-.md files', async () => {
      const dir = join(root, 'agents');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'a.md'), '---\nname: a\n---\nbody\n', 'utf8');
      await writeFile(join(dir, 'README.txt'), 'noise', 'utf8');
      const defs = await provider.loadSubagents(dir);
      expect(defs.map((d) => d.name)).toEqual(['a']);
    });
  });

  describe('loadCapabilities', () => {
    it('bundles a flat-layout skill at .claude/skills/<name>/ paths', async () => {
      const dir = join(root, 'skills');
      await mkdir(join(dir, 'my-skill', 'references'), { recursive: true });
      await writeFile(join(dir, 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nbody\n', 'utf8');
      await writeFile(join(dir, 'my-skill', 'references', 'a.md'), 'ref a', 'utf8');

      const bundles = await provider.loadCapabilities(dir);
      expect(bundles).toHaveLength(1);
      const [b] = bundles;
      expect(b.name).toBe('my-skill');

      // Files land at .claude/skills/my-skill/* so the overlay engine
      // writes them to <workspace>/.claude/skills/my-skill/* — the
      // adapter-reserved path the claude binary natively discovers. No
      // synthesized pangolin-setup.sh (it would collide last-write-wins on
      // multi-cap dispatches).
      expect(Object.keys(b.files).sort()).toEqual([
        '.claude/skills/my-skill/SKILL.md',
        '.claude/skills/my-skill/references/a.md',
      ]);
      expect(b.files['pangolin-setup.sh']).toBeUndefined();
    });

    it('walks nested layouts and registers each SKILL.md-marked dir as one skill', async () => {
      // Mirrors the user's pokemon layout:
      //   skills/abra/_pokemon.json
      //   skills/abra/move-tdd-cycle/SKILL.md
      //   skills/abra/move-codemap/SKILL.md
      const dir = join(root, 'skills');
      await mkdir(join(dir, 'abra', 'move-tdd-cycle'), { recursive: true });
      await mkdir(join(dir, 'abra', 'move-codemap'), { recursive: true });
      await writeFile(join(dir, 'abra', '_pokemon.json'), '{}', 'utf8');
      await writeFile(join(dir, 'abra', 'move-tdd-cycle', 'SKILL.md'), 'tdd body', 'utf8');
      await writeFile(join(dir, 'abra', 'move-codemap', 'SKILL.md'), 'codemap body', 'utf8');

      const bundles = await provider.loadCapabilities(dir);
      const names = bundles.map((b) => b.name).sort();
      expect(names).toEqual(['move-codemap', 'move-tdd-cycle']);

      const tdd = bundles.find((b) => b.name === 'move-tdd-cycle')!;
      expect(Object.keys(tdd.files)).toEqual(['.claude/skills/move-tdd-cycle/SKILL.md']);
      // _pokemon.json lives at the pokemon-folder level, which is NOT the
      // skill dir — it must not leak into the skill bundle.
      expect(tdd.files['.claude/skills/move-tdd-cycle/_pokemon.json']).toBeUndefined();
    });

    it('does not recurse into a skill once SKILL.md is found at its root', async () => {
      // skills/outer/SKILL.md
      // skills/outer/references/inner/SKILL.md  ← MUST NOT register as a sibling
      const dir = join(root, 'skills');
      await mkdir(join(dir, 'outer', 'references', 'inner'), { recursive: true });
      await writeFile(join(dir, 'outer', 'SKILL.md'), 'outer', 'utf8');
      await writeFile(join(dir, 'outer', 'references', 'inner', 'SKILL.md'), 'inner', 'utf8');

      const bundles = await provider.loadCapabilities(dir);
      expect(bundles.map((b) => b.name)).toEqual(['outer']);
      // The nested SKILL.md is still bundled INTO outer (as just a file).
      expect(bundles[0].files['.claude/skills/outer/references/inner/SKILL.md']).toBeDefined();
    });

    it('silently dedupes same-name skills that have identical content', async () => {
      const dir = join(root, 'skills');
      await mkdir(join(dir, 'abra', 'move-x'), { recursive: true });
      await mkdir(join(dir, 'bulbasaur', 'move-x'), { recursive: true });
      await writeFile(join(dir, 'abra', 'move-x', 'SKILL.md'), 'identical body', 'utf8');
      await writeFile(join(dir, 'bulbasaur', 'move-x', 'SKILL.md'), 'identical body', 'utf8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bundles = await provider.loadCapabilities(dir);
      expect(bundles.map((b) => b.name)).toEqual(['move-x']);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns and keeps the last variant when same-name skills have different content', async () => {
      const dir = join(root, 'skills');
      await mkdir(join(dir, 'abra', 'move-x'), { recursive: true });
      await mkdir(join(dir, 'bulbasaur', 'move-x'), { recursive: true });
      await writeFile(join(dir, 'abra', 'move-x', 'SKILL.md'), 'variant a', 'utf8');
      await writeFile(join(dir, 'bulbasaur', 'move-x', 'SKILL.md'), 'variant b', 'utf8');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bundles = await provider.loadCapabilities(dir);
      expect(bundles.map((b) => b.name)).toEqual(['move-x']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/collision 'move-x' .* DIFFERENT content/),
      );
    });

    it('skips dotfile directories during the walk', async () => {
      const dir = join(root, 'skills');
      await mkdir(join(dir, '.cache', 'phantom-skill'), { recursive: true });
      await writeFile(join(dir, '.cache', 'phantom-skill', 'SKILL.md'), 'noise', 'utf8');
      await mkdir(join(dir, 'real-skill'), { recursive: true });
      await writeFile(join(dir, 'real-skill', 'SKILL.md'), 'body', 'utf8');

      const bundles = await provider.loadCapabilities(dir);
      expect(bundles.map((b) => b.name)).toEqual(['real-skill']);
    });

    it('produces deterministic file maps across runs', async () => {
      const dir = join(root, 'skills');
      await mkdir(join(dir, 'det'), { recursive: true });
      await writeFile(join(dir, 'det', 'SKILL.md'), 'body', 'utf8');

      const a = await provider.loadCapabilities(dir);
      const b = await provider.loadCapabilities(dir);
      expect(Object.keys(a[0].files).sort()).toEqual(Object.keys(b[0].files).sort());
      for (const key of Object.keys(a[0].files)) {
        expect(a[0].files[key]).toEqual(b[0].files[key]);
      }
    });
  });
});

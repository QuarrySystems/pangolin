import { it, expect, describe } from 'vitest';
import { claudeAuthSecrets } from '../src/claude-auth.js';

const API_KEY = 'sk-ant-api03-' + 'A'.repeat(40);
const OAUTH = 'sk-ant-oat01-' + 'B'.repeat(40);

describe('claudeAuthSecrets', () => {
  describe('auto-detection (no PANGOLIN_CLAUDE_AUTH)', () => {
    it('picks api-key when only ANTHROPIC_API_KEY is set', () => {
      const r = claudeAuthSecrets({ ANTHROPIC_API_KEY: API_KEY });
      expect(r.mode).toBe('api-key');
      expect(r.credentialName).toBe('ANTHROPIC_API_KEY');
      expect(r.present).toBe(true);
      expect(r.secrets).toEqual({ ANTHROPIC_API_KEY: { inline: API_KEY } });
    });

    it('picks subscription when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
      const r = claudeAuthSecrets({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH });
      expect(r.mode).toBe('subscription');
      expect(r.credentialName).toBe('CLAUDE_CODE_OAUTH_TOKEN');
      expect(r.present).toBe(true);
      expect(r.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: { inline: OAUTH } });
    });

    it('prefers subscription and stages ONLY the OAuth token when BOTH are set', () => {
      // The CLI's auth precedence puts ANTHROPIC_API_KEY ABOVE the OAuth token,
      // so staging both would silently bill API credits. Must stage exactly one.
      const r = claudeAuthSecrets({
        ANTHROPIC_API_KEY: API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      });
      expect(r.mode).toBe('subscription');
      expect(r.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: { inline: OAUTH } });
      expect(r.secrets).not.toHaveProperty('ANTHROPIC_API_KEY');
    });

    it('treats an empty-string OAuth token as absent (falls back to api-key)', () => {
      const r = claudeAuthSecrets({ ANTHROPIC_API_KEY: API_KEY, CLAUDE_CODE_OAUTH_TOKEN: '' });
      expect(r.mode).toBe('api-key');
      expect(r.secrets).toEqual({ ANTHROPIC_API_KEY: { inline: API_KEY } });
    });
  });

  describe('explicit PANGOLIN_CLAUDE_AUTH override', () => {
    it('forces api-key even when an OAuth token is present', () => {
      const r = claudeAuthSecrets({
        PANGOLIN_CLAUDE_AUTH: 'api-key',
        ANTHROPIC_API_KEY: API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      });
      expect(r.mode).toBe('api-key');
      expect(r.secrets).toEqual({ ANTHROPIC_API_KEY: { inline: API_KEY } });
    });

    it('forces subscription even when only ANTHROPIC_API_KEY is present', () => {
      const r = claudeAuthSecrets({
        PANGOLIN_CLAUDE_AUTH: 'subscription',
        ANTHROPIC_API_KEY: API_KEY,
      });
      expect(r.mode).toBe('subscription');
      expect(r.credentialName).toBe('CLAUDE_CODE_OAUTH_TOKEN');
      // No token value available → staged empty, present=false (preflight will flag it).
      expect(r.present).toBe(false);
      expect(r.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: { inline: '' } });
    });

    it('throws on an unrecognized override value', () => {
      expect(() => claudeAuthSecrets({ PANGOLIN_CLAUDE_AUTH: 'oauth' })).toThrow(
        /PANGOLIN_CLAUDE_AUTH/,
      );
    });
  });

  describe('import-safe / empty environment', () => {
    it('returns api-key mode with an empty value and present=false', () => {
      const r = claudeAuthSecrets({});
      expect(r.mode).toBe('api-key');
      expect(r.present).toBe(false);
      expect(r.secrets).toEqual({ ANTHROPIC_API_KEY: { inline: '' } });
    });
  });

  describe('invariants', () => {
    it('always stages exactly one secret', () => {
      for (const env of [
        {},
        { ANTHROPIC_API_KEY: API_KEY },
        { CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
        { ANTHROPIC_API_KEY: API_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
        { PANGOLIN_CLAUDE_AUTH: 'subscription' as const },
      ]) {
        expect(Object.keys(claudeAuthSecrets(env).secrets)).toHaveLength(1);
      }
    });
  });
});

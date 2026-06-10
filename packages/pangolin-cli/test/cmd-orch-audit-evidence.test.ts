import { describe, it, expect } from 'vitest';
import { renderEvidenceLine } from '../src/cmd-orch.js';

describe('renderEvidenceLine', () => {
  it('shows item id, PASS, model, and costUsd for a passing item', () => {
    const line = renderEvidenceLine('appeal-001', { passed: true }, ['claude-haiku-4-5-20251001'], 0.0021);
    expect(line).toMatch(/appeal-001/);
    expect(line).toMatch(/PASS/);
    expect(line).toMatch(/claude-haiku-4-5-20251001/);
    expect(line).toMatch(/0\.0021/);
  });

  it('shows FAIL for a failing self-verify result', () => {
    const line = renderEvidenceLine('appeal-002', { passed: false }, ['claude-sonnet-4-5'], 0.005);
    expect(line).toMatch(/appeal-002/);
    expect(line).toMatch(/FAIL/);
    expect(line).not.toMatch(/PASS/);
    expect(line).toMatch(/claude-sonnet-4-5/);
    expect(line).toMatch(/0\.005/);
  });

  it('shows PASS for a passing item with undefined verify', () => {
    // When verify is undefined, no self-verify result is known — show "?" sentinel
    const line = renderEvidenceLine('appeal-003', undefined, ['claude-opus-4-5'], 0.01);
    expect(line).toMatch(/appeal-003/);
    // Should not crash — shows a neutral indicator
    expect(line).not.toMatch(/PASS/);
    expect(line).not.toMatch(/FAIL/);
  });

  it('handles undefined model and costUsd gracefully', () => {
    const line = renderEvidenceLine('appeal-004', { passed: true }, undefined, undefined);
    expect(line).toMatch(/appeal-004/);
    expect(line).toMatch(/PASS/);
    // Should still produce a valid line without throwing
    expect(typeof line).toBe('string');
  });

  it('handles multiple models by showing all of them', () => {
    const line = renderEvidenceLine('appeal-005', { passed: true }, ['model-a', 'model-b'], 0.003);
    expect(line).toMatch(/model-a/);
    expect(line).toMatch(/model-b/);
    expect(line).toMatch(/PASS/);
    expect(line).toMatch(/0\.003/);
  });
});

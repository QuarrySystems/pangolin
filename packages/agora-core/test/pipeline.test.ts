import { describe, it, expect } from 'vitest';
import { validatePipelineSpec, isPackScopedId } from '../src/pipeline.js';
import type { PipelineSpec } from '../src/pipeline.js';

// ---------------------------------------------------------------------------
// isPackScopedId
// ---------------------------------------------------------------------------

describe('isPackScopedId', () => {
  it('accepts valid pack-scoped ids', () => {
    expect(isPackScopedId('dev.code-edit')).toBe(true);
    expect(isPackScopedId('data.split')).toBe(true);
    expect(isPackScopedId('my-pack.my-name')).toBe(true);
    expect(isPackScopedId('a.b')).toBe(true);
    expect(isPackScopedId('abc123.def456')).toBe(true);
  });

  it('rejects ids without a dot', () => {
    expect(isPackScopedId('nodot')).toBe(false);
    expect(isPackScopedId('')).toBe(false);
  });

  it('rejects ids with uppercase letters', () => {
    expect(isPackScopedId('Upper.case')).toBe(false);
    expect(isPackScopedId('dev.CodeEdit')).toBe(false);
  });

  it('rejects ids with more than one dot (a.b.c)', () => {
    expect(isPackScopedId('a.b.c')).toBe(false);
  });

  it('rejects ids with leading/trailing dots or underscores', () => {
    expect(isPackScopedId('.foo')).toBe(false);
    expect(isPackScopedId('foo.')).toBe(false);
    expect(isPackScopedId('foo_bar.baz')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineSpec — valid spec
// ---------------------------------------------------------------------------

describe('validatePipelineSpec — valid specs', () => {
  const base: PipelineSpec = {
    schemaVersion: 1,
    id: 'data.split',
    blocks: [{ kind: 'agent' }],
  };

  it('returns empty array for a minimal valid spec', () => {
    expect(validatePipelineSpec(base)).toEqual([]);
  });

  it('accepts a full spec with all optional fields', () => {
    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.code-edit',
      blocks: [
        { kind: 'agent' },
        { kind: 'capture', what: 'patch' },
        { kind: 'script', command: 'npm test', timeoutSeconds: 120, lens: 'verify' },
        { kind: 'capture', what: 'outputs' },
      ],
      outputEdgeType: 'patch-ref',
      inputEdgeTypes: { dataset: 'dataset-ref' },
    };
    expect(validatePipelineSpec(spec)).toEqual([]);
  });

  it('accepts script block with lens: gate', () => {
    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'data.transform',
      blocks: [{ kind: 'script', command: 'node -e "process.exit(0)"', lens: 'gate' }],
    };
    expect(validatePipelineSpec(spec)).toEqual([]);
  });

  it('accepts script block with no optional fields', () => {
    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'data.aggregate',
      blocks: [{ kind: 'script', command: 'true' }],
    };
    expect(validatePipelineSpec(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineSpec — schemaVersion
// ---------------------------------------------------------------------------

describe('validatePipelineSpec — schemaVersion errors', () => {
  it('rejects schemaVersion !== 1', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 2 as unknown as 1,
      id: 'data.split',
      blocks: [{ kind: 'agent' }],
    });
    expect(errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineSpec — id
// ---------------------------------------------------------------------------

describe('validatePipelineSpec — id errors', () => {
  it('rejects non-pack-scoped id', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'nodot',
      blocks: [{ kind: 'agent' }],
    });
    expect(errors.some((e) => e.includes('"nodot"') && e.includes('<pack>.<name>'))).toBe(true);
  });

  it('rejects id with uppercase', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'Dev.Edit',
      blocks: [{ kind: 'agent' }],
    });
    expect(errors.some((e) => e.includes('<pack>.<name>'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineSpec — blocks
// ---------------------------------------------------------------------------

describe('validatePipelineSpec — blocks errors', () => {
  it('rejects empty blocks array', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [],
    });
    expect(errors.some((e) => e.includes('blocks') && e.includes('non-empty'))).toBe(true);
  });

  it('rejects non-array blocks', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: null as unknown as never[],
    });
    expect(errors.some((e) => e.includes('blocks') && e.includes('non-empty'))).toBe(true);
  });

  it("rejects the reserved 'seal' kind with a pointed error", () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'script', command: 'true' }, { kind: 'seal' } as never],
    });
    expect(errors.some((e) => e.includes('reserved') && e.includes('auto-appended'))).toBe(true);
  });

  it('rejects unknown kind', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'unknown-kind' } as never],
    });
    expect(errors.some((e) => e.includes('unknown') && e.includes('kind'))).toBe(true);
  });

  it('rejects a null block element without throwing', () => {
    const errors = validatePipelineSpec({ schemaVersion: 1, id: 'data.split', blocks: [null as never] });
    expect(errors.some((e) => e.includes('blocks[0]'))).toBe(true);
  });

  it('rejects a non-object block element (number) without throwing', () => {
    const errors = validatePipelineSpec({ schemaVersion: 1, id: 'data.split', blocks: [42 as never] });
    expect(errors.some((e) => e.includes('blocks[0]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineSpec — script block validation
// ---------------------------------------------------------------------------

describe('validatePipelineSpec — script block errors', () => {
  it('rejects script block with empty command', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'script', command: '' }],
    });
    expect(errors.some((e) => e.includes('command') && e.includes('non-empty'))).toBe(true);
  });

  it('rejects script block with non-positive timeoutSeconds (zero)', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'script', command: 'true', timeoutSeconds: 0 }],
    });
    expect(errors.some((e) => e.includes('timeoutSeconds') && e.includes('positive'))).toBe(true);
  });

  it('rejects script block with negative timeoutSeconds', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'script', command: 'true', timeoutSeconds: -1 }],
    });
    expect(errors.some((e) => e.includes('timeoutSeconds') && e.includes('positive'))).toBe(true);
  });

  it('rejects script block with invalid lens', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'script', command: 'true', lens: 'invalid' as never }],
    });
    expect(errors.some((e) => e.includes('lens'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineSpec — capture block validation
// ---------------------------------------------------------------------------

describe('validatePipelineSpec — capture block errors', () => {
  it('rejects capture block with invalid what', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'capture', what: 'invalid' as never }],
    });
    expect(errors.some((e) => e.includes('what'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineSpec — tag field validation
// ---------------------------------------------------------------------------

describe('validatePipelineSpec — tag field errors', () => {
  it('rejects empty-string outputEdgeType', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'agent' }],
      outputEdgeType: '',
    });
    expect(errors.some((e) => e.includes('outputEdgeType') && e.includes('non-empty'))).toBe(true);
  });

  it('rejects empty-string value in inputEdgeTypes', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [{ kind: 'agent' }],
      inputEdgeTypes: { dataset: '' },
    });
    expect(errors.some((e) => e.includes('inputEdgeTypes') && e.includes('non-empty'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipelineSpec — collect-all (multiple errors in one pass)
// ---------------------------------------------------------------------------

describe('validatePipelineSpec — collect-all errors', () => {
  it('reports multiple errors in a single pass', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 2 as unknown as 1,
      id: 'nodot',
      blocks: [],
    });
    // Should report schemaVersion error AND id error AND blocks error
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((e) => e.includes('schemaVersion'))).toBe(true);
    expect(errors.some((e) => e.includes('<pack>.<name>'))).toBe(true);
    expect(errors.some((e) => e.includes('blocks'))).toBe(true);
  });

  it('collects errors from multiple invalid blocks', () => {
    const errors = validatePipelineSpec({
      schemaVersion: 1,
      id: 'data.split',
      blocks: [
        { kind: 'script', command: '' } as never,
        { kind: 'capture', what: 'invalid' as never },
      ],
    });
    // Both blocks should produce errors
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

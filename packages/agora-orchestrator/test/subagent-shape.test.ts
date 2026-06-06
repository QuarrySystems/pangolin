import { describe, it, expect } from 'vitest';
import { validateShape } from '../src/contracts/subagent-shape.js';
import { makeShape } from './support/make-shape.js';

describe('validateShape', () => {
  it('accepts a well-formed shape', () => {
    expect(() => validateShape(makeShape())).not.toThrow();
  });

  it('rejects an unprefixed id', () => {
    expect(() => validateShape(makeShape({ id: 'noprefix' }))).toThrow(/<pack>\.<name>/);
  });

  it('rejects an id with too many dots', () => {
    expect(() => validateShape(makeShape({ id: 'dev.code.edit' }))).toThrow(/<pack>\.<name>/);
  });

  it('rejects an invalid effectTier', () => {
    expect(() =>
      validateShape(makeShape({ effectTier: 'network-impure' as never }))
    ).toThrow(/effectTier/);
  });

  it('requires capability.imageDigest', () => {
    expect(() =>
      validateShape(
        makeShape({ capability: { imageDigest: '', permissions: {}, contextShape: '' } })
      )
    ).toThrow(/imageDigest/);
  });

  it('rejects an empty outputEdgeType', () => {
    expect(() => validateShape(makeShape({ outputEdgeType: '' }))).toThrow(/outputEdgeType/);
  });

  it('rejects an inputEdgeTypes entry with an empty-string value', () => {
    expect(() => validateShape(makeShape({ inputEdgeTypes: { x: '' } }))).toThrow(/inputEdgeTypes/);
  });

  it('accepts a shape with declared edge-type tags', () => {
    expect(() => validateShape(makeShape({
      outputEdgeType: 'patch-ref', inputEdgeTypes: { patch: 'patch-ref' },
    }))).not.toThrow();
  });

  it('accepts and rejects the same ids as core isPackScopedId', () => {
    // Valid ids should pass
    expect(() => validateShape(makeShape({ id: 'dev.code-edit' }))).not.toThrow();
    expect(() => validateShape(makeShape({ id: 'x.y' }))).not.toThrow();
    expect(() => validateShape(makeShape({ id: 'foo-bar.baz-qux' }))).not.toThrow();
    expect(() => validateShape(makeShape({ id: 'a123.b456' }))).not.toThrow();

    // Invalid ids should throw with the exact message
    expect(() => validateShape(makeShape({ id: 'nodot' }))).toThrow(
      /SubagentShape: id "nodot" must be "<pack>\.<name>"/
    );
    expect(() => validateShape(makeShape({ id: 'too.many.dots' }))).toThrow(
      /SubagentShape: id "too\.many\.dots" must be "<pack>\.<name>"/
    );
    expect(() => validateShape(makeShape({ id: '.dot' }))).toThrow(
      /must be "<pack>\.<name>"/
    );
    expect(() => validateShape(makeShape({ id: 'dot.' }))).toThrow(
      /must be "<pack>\.<name>"/
    );
    expect(() => validateShape(makeShape({ id: 'upper.Case' }))).toThrow(
      /must be "<pack>\.<name>"/
    );
    expect(() => validateShape(makeShape({ id: 'pack.name_with_underscore' }))).toThrow(
      /must be "<pack>\.<name>"/
    );
  });
});

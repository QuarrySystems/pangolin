import { it, expect } from 'vitest';
import * as barrel from '../src/index.js';

const EXPECTED_EXPORTS = [
  'ArtifactRefRejectedError',
  'assertArtifactRef',
  'fetchDispatchArtifact',
  'parseOutputSentinel',
  'readOutputSentinel',
].sort();

it('imports cleanly with no I/O or env access at module load', () => {
  // The import above already happened at module-evaluation time; reaching
  // this line without a thrown error is itself part of the proof.
  expect(barrel).toBeDefined();
});

it('exports exactly the expected value surface — no accidental extras', () => {
  // `export type` declarations are erased at runtime and correctly do not
  // appear here; only runtime values (functions, classes) show up in
  // Object.keys of a namespace import.
  expect(Object.keys(barrel).sort()).toEqual(EXPECTED_EXPORTS);
});

it('exports parseOutputSentinel as a function', () => {
  expect(typeof barrel.parseOutputSentinel).toBe('function');
});

it('exports readOutputSentinel as a function', () => {
  expect(typeof barrel.readOutputSentinel).toBe('function');
});

it('exports assertArtifactRef as a function', () => {
  expect(typeof barrel.assertArtifactRef).toBe('function');
});

it('exports fetchDispatchArtifact as a function', () => {
  expect(typeof barrel.fetchDispatchArtifact).toBe('function');
});

it('exports ArtifactRefRejectedError as a class extending Error', () => {
  expect(typeof barrel.ArtifactRefRejectedError).toBe('function');
  expect(barrel.ArtifactRefRejectedError.prototype).toBeInstanceOf(Error);
});

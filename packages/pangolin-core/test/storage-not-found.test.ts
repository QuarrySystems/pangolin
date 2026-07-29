import { describe, expect, it } from 'vitest';
import { StorageNotFoundError, isStorageNotFound } from '../src/errors.js';

describe('StorageNotFoundError', () => {
  it('produces a default message, correct name, and readable uri', () => {
    const uri = 'pangolin://ns/blobs/abc123';
    const e = new StorageNotFoundError(uri);
    expect(e.message).toBe(`storage object not found: ${uri}`);
    expect(e.name).toBe('StorageNotFoundError');
    expect(e.uri).toBe(uri);
  });

  it('lets a provider supply its own message while keeping uri and name', () => {
    const uri = 'pangolin://ns/dispatches/d1/output.json';
    const e = new StorageNotFoundError(
      uri,
      `LocalStorageProvider: dispatch record not found for URI: ${uri}`,
    );
    expect(e.message).toMatch(/dispatch record not found/); // storage-local keeps its two messages
    expect(e.uri).toBe(uri);
    expect(e.name).toBe('StorageNotFoundError');
  });
});

describe('isStorageNotFound', () => {
  it('returns true for a StorageNotFoundError instance', () => {
    expect(isStorageNotFound(new StorageNotFoundError('pangolin://ns/blobs/x'))).toBe(true);
  });

  it('returns true for a plain object whose name is StorageNotFoundError', () => {
    expect(isStorageNotFound({ name: 'StorageNotFoundError' })).toBe(true);
  });

  it('does not classify unrelated values as not-found', () => {
    expect(isStorageNotFound(new Error('S3 bucket policy denies access'))).toBe(false);
    expect(isStorageNotFound(null)).toBe(false);
    expect(isStorageNotFound(undefined)).toBe(false);
    expect(isStorageNotFound('not found')).toBe(false);
  });
});

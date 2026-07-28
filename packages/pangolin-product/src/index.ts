// @quarry-systems/pangolin-product
//
// Single public entry point. Every other Pangolin Scale package imports from
// `@quarry-systems/pangolin-product` (this barrel), never from individual
// sub-files. This file locks the public contract.

export { parseOutputSentinel } from './sentinel-parse.js';
export type { SentinelReadResult, SentinelMalformedReason } from './sentinel-parse.js';
export { readOutputSentinel } from './sentinel-read.js';
export { assertArtifactRef, ArtifactRefRejectedError } from './artifact-ref.js';
export type { ArtifactRefRejection } from './artifact-ref.js';
export { fetchDispatchArtifact } from './artifact-fetch.js';

// pangolin-worker: container-side runtime for DAG 2
// Runtime-agnostic — dispatches to the configured RuntimeAdapter.
export { runWorker } from './entrypoint.js';
export {
  parseWorkerEnv,
  type WorkerConfig,
  type BundleRefs,
} from './env-parser.js';
export { LifecycleEmitter } from './lifecycle.js';
export { StructuredLogger } from './logger.js';
export { mergeEnv, type EnvBundle } from './env-merger.js';
export {
  overlayCapabilities,
  type CapabilityBundle,
} from './overlay-engine.js';
export {
  fetchBundles,
  constructStorageProvider,
  type FetchedBundles,
} from './bundle-fetcher.js';
export { loadRuntimeAdapter } from './adapter-loader.js';
export { runSetupScriptIfPresent, SetupScriptError } from './setup-script.js';
export { loadChannelIfPresent, type ChannelHandle } from './channel-loader.js';
export {
  resolveNeedsInputSentinel,
  type NeedsInputOutcome,
} from './needs-input.js';
export { loadCapabilityNotifications, fireNotifications } from './notifications.js';
export { applyMergeRule, MergeTypeConflictError } from './merge-rules.js';

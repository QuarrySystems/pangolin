// deploy/serve-stack/check-metrics-wiring.mjs
// Import-safe verification that the config exposes a shared metrics recorder whose
// snapshot has the MetricsSnapshot shape. Run: node deploy/serve-stack/check-metrics-wiring.mjs
import { orch } from './pangolin.config.mjs';

const snap = orch.metrics.snapshot();
const ok =
  snap &&
  typeof snap.counters === 'object' &&
  typeof snap.gauges === 'object' &&
  typeof snap.histograms === 'object';
if (!ok) {
  console.error('FAIL: orch.metrics.snapshot() is not a MetricsSnapshot');
  process.exit(1);
}
console.log('ok: orch.metrics.snapshot() shape verified');

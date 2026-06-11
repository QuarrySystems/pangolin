import type { Run, Trigger } from '../contracts/index.js';

export class ManualTrigger implements Trigger {
  readonly id = 'manual';
  /** Root items (no deps) are ready the moment the run is submitted. */
  initialReady(run: Run): string[] {
    return run.items.filter((i) => i.depends_on.length === 0).map((i) => i.id);
  }
}

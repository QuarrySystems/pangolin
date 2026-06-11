import type { Run } from './types.js';

/** Policy that readies work. The skeleton ships only `manual`. */
export interface Trigger {
  id: string;
  /** ids of items to mark ready the moment a run is submitted (e.g. its roots). */
  initialReady(run: Run): string[];
}

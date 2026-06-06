import type { Pattern } from '../contracts/pattern.js';

export const staticDag: Pattern = {
  id: 'static-dag',
  plan: (run) => run,
  onTaskDone: () => null,
};

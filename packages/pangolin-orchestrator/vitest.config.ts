import { mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// Repo-wide defaults (notably testTimeout) live in vitest.shared.ts — this package
// was where the 5s-default problem was first diagnosed, and that reasoning now
// lives there rather than being duplicated here.
//
// `include` is left at the vitest default (`**/*.test.ts`), so the cross-process
// `*.xproc.ts` files stay excluded — they run via `test:xproc` + vitest.xproc.config.ts.
export default mergeConfig(shared, {});

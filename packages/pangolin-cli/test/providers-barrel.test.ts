import { it, expect } from 'vitest';
import * as barrel from '../src/providers/index.js';

it('publishes exactly the SPI surface and no registry internals', () => {
  expect(Object.keys(barrel).sort()).toEqual(
    ['ClaudeCodeProvider', 'StoaProvider', 'splitFrontmatter'].sort(),
  );
});

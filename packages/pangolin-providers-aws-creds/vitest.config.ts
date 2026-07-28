import { mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// Repo-wide defaults (notably testTimeout) live in vitest.shared.ts — see that
// file for why vitest's 5s default is inadequate here. Add package-specific
// config as a second mergeConfig argument.
export default mergeConfig(shared, {});

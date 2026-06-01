// fixture/shared.ts — trivial shared file for the real-Docker code-edit subagent demo.
// The subagent is instructed to rename OLD_NAME → NEW_NAME.
// This file's lock serializes any concurrent edits (only one subagent can hold it at a time).
export const OLD_NAME = 'shared';
export const SHARED_VALUE = 42;

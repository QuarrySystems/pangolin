// fixture/shared.ts — trivial file for the real code-edit subagent demo.
// The subagent is instructed to rename OLD_NAME → NEW_NAME.
// Two plan items (edit-shared-1, edit-shared-2) contend on this lock;
// the rename is idempotent so execution order doesn't matter.
export const OLD_NAME = 1;

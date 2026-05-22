import { attachCapabilitiesCmd } from '../src/cmd-capabilities.js';
import { Command } from 'commander';
import { it, expect } from 'vitest';

it('attachCapabilitiesCmd registers register/list/get subcommands', () => {
  const program = new Command();
  attachCapabilitiesCmd(program, { getClient: async () => ({} as any) });
  const caps = program.commands.find((c) => c.name() === 'capabilities')!;
  const subNames = caps.commands.map((c) => c.name()).sort();
  expect(subNames).toEqual(['get', 'list', 'register']);
});

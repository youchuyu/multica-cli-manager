#!/usr/bin/env node
import { resolve } from 'node:path';
import { createProject } from '../src/commands/create-project.mjs';
import { syncWorkspace } from '../src/commands/workspace-sync.mjs';

const args = process.argv.slice(2);
const command = args[0];
const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

try {
  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage:
  npx multica-cli-manager <project-name>
  multica-cli-manager workspace pull <slug|id> [--profile <name>] [--dry-run] [--hard]
  multica-cli-manager workspace diff <slug|id> [--profile <name>]
  multica-cli-manager workspace push <slug|id> [--profile <name>] [--dry-run] [--hard]

pull and push validate, execute, and reread for verification by default.
--dry-run prints the complete plan without writing. --hard resolves conflicts in
the requested direction and enables target cleanup; it never bypasses schema,
identity, scope, or path safety checks. --workspace remains temporarily supported.`);
  } else if (command === 'workspace') {
    const action = args[1];
    if (!['pull', 'diff', 'push'].includes(action)) throw new Error('workspace action must be pull, diff, or push');
    const positional = args[2]?.startsWith('-') ? undefined : args[2];
    const flagged = value('--workspace');
    if (positional && flagged && positional !== flagged) throw new Error('positional workspace and --workspace must match');
    await syncWorkspace({
      root: process.cwd(), action,
      workspace: positional || flagged, profile: value('--profile'),
      dryRun: args.includes('--dry-run'), hard: args.includes('--hard'), output: value('--output') || 'text'
    });
  } else {
    await createProject(resolve(process.cwd(), command), command);
  }
} catch (error) {
  console.error(`multica-cli-manager: ${error.message}`);
  process.exitCode = error.code === 'CONFLICT' ? 2 : 1;
}

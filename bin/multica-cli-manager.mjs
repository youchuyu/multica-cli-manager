#!/usr/bin/env node
import { resolve } from 'node:path';
import { createProject } from '../src/create-project.mjs';
import { syncWorkspace } from '../src/workspace-sync.mjs';

const args = process.argv.slice(2);
const command = args[0];
const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

try {
  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage:
  npx multica-cli-manager <project-name>
  multica-cli-manager workspace pull --workspace <slug|id> [--profile <name>]
  multica-cli-manager workspace diff --workspace <slug|id> [--profile <name>]
  multica-cli-manager workspace push --workspace <slug|id> [--profile <name>] [--apply]

push previews by default. --apply updates existing Agent, Skill, Skill files,
and Project resources, then rereads the remote state for verification.`);
  } else if (command === 'workspace') {
    const action = args[1];
    if (!['pull', 'diff', 'push'].includes(action)) throw new Error('workspace action must be pull, diff, or push');
    await syncWorkspace({
      root: process.cwd(), action,
      workspace: value('--workspace'), profile: value('--profile'),
      apply: args.includes('--apply')
    });
  } else {
    await createProject(resolve(process.cwd(), command), command);
  }
} catch (error) {
  console.error(`multica-cli-manager: ${error.message}`);
  process.exitCode = 1;
}

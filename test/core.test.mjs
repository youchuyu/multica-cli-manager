import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../src/create-project.mjs';
import { agentMarkdown, parseAgent } from '../src/workspace-format.mjs';

test('creates an empty workspace scaffold', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'multica-manager-'));
  const target = join(temp, 'demo');
  await createProject(target, 'demo');
  const packageJson = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['workspace:pull'], 'multica-cli-manager workspace pull');
  assert.equal(await readFile(join(target, 'src/workspace/.gitkeep'), 'utf8'), '');
});

test('round trips agent markdown', () => {
  const remote = { name: 'Planner', description: 'Plans work', model: 'gpt-5.6', instructions: 'Plan clearly.' };
  const parsed = parseAgent(agentMarkdown(remote));
  assert.equal(parsed.fields.name, 'Planner');
  assert.equal(parsed.fields.model, 'gpt-5.6');
  assert.equal(parsed.instructions, 'Plan clearly.');
});

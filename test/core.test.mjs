import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../src/commands/create-project.mjs';
import { changedFields, normalizeText, pick, AGENT_FIELDS } from '../src/workspace/format.mjs';
import { syncWorkspace } from '../src/commands/workspace-sync.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const skillId = '33333333-3333-4333-8333-333333333333';
const projectId = '44444444-4444-4444-8444-444444444444';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multica-sync-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const statePath = join(root, 'state.json'); const callsPath = join(root, 'calls.jsonl');
  await writeFile(statePath, JSON.stringify({
    workspace: { id: workspaceId, name: 'Demo', slug: 'demo', description: 'excluded' },
    agents: [{ id: agentId, name: 'Planner', description: 'Plans', runtime_id: 'runtime', model: 'gpt-5', thinking_level: 'medium', permission_mode: 'private', max_concurrent_tasks: 6, instructions: 'Plan.\n', custom_env: { TOKEN: 'secret' }, status: 'idle' }],
    skills: [{ id: skillId, name: 'Guide', description: 'Routes work', content: '# Guide\n', config: { hidden: true }, files: [{ path: 'references/a.md', content: 'A\n' }] }],
    projects: [{ id: projectId, title: 'Roadmap', description: 'Work', status: 'planned', priority: 'high' }]
  }));
  const executable = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const statePath = process.env.FAKE_MULTICA_STATE; const callsPath = process.env.FAKE_MULTICA_CALLS;
const state = JSON.parse(readFileSync(statePath, 'utf8')); const args = process.argv.slice(2);
appendFileSync(callsPath, JSON.stringify(args) + '\\n');
const positional = args.filter((v, i) => !v.startsWith('--') && !['--profile','--workspace-id','--output','--name','--description','--instructions','--runtime-id','--model','--thinking-level','--permission-mode','--max-concurrent-tasks','--title','--status','--path'].includes(args[i-1]));
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const input = readFileSync(0, 'utf8'); let result; let mutated = false;
if (args[0] === 'workspace' && args[1] === 'get') result = state.workspace;
else if (args[1] === 'list' && ['agent','skill','project'].includes(args[0])) result = state[args[0] + 's'].map(({id,name,title}) => ({id,name,title}));
else if (args[0] === 'skill' && args[1] === 'files' && args[2] === 'list') result = state.skills.find(x => x.id === args[3]).files;
else if (args[1] === 'get') result = state[args[0] + 's'].find(x => x.id === args[2]);
else if (args[0] === 'agent' && args[1] === 'update') { const x = state.agents.find(x => x.id === args[2]); for (const [flag,key] of [['--name','name'],['--description','description'],['--instructions','instructions'],['--runtime-id','runtime_id'],['--model','model'],['--thinking-level','thinking_level'],['--permission-mode','permission_mode']]) if (args.includes(flag)) x[key] = option(flag); if (args.includes('--max-concurrent-tasks')) x.max_concurrent_tasks = Number(option('--max-concurrent-tasks')); mutated=true; result=x; }
else if (args[0] === 'skill' && args[1] === 'update') { const x=state.skills.find(x=>x.id===args[2]); if(args.includes('--name')) x.name=option('--name'); if(args.includes('--description')) x.description=option('--description'); if(args.includes('--content-stdin')) x.content=input; mutated=true; result=x; }
else if (args[0] === 'skill' && args[1] === 'files' && args[2] === 'upsert') { const x=state.skills.find(x=>x.id===args[3]); const path=option('--path'); const file=x.files.find(f=>f.path===path); if(file) file.content=input; else x.files.push({path,content:input}); mutated=true; result={path}; }
else if (args[0] === 'project' && args[1] === 'update') { const x=state.projects.find(x=>x.id===args[2]); x.title=option('--title'); x.description=option('--description'); x.status=option('--status'); mutated=true; result=x; }
else { console.error('unsupported', args.join(' ')); process.exit(2); }
if(mutated) writeFileSync(statePath, JSON.stringify(state)); process.stdout.write(JSON.stringify(result));
`;
  const command = join(bin, 'multica'); await writeFile(command, executable); await chmod(command, 0o755);
  return { root, statePath, callsPath, env: { PATH: `${bin}:${process.env.PATH}`, FAKE_MULTICA_STATE: statePath, FAKE_MULTICA_CALLS: callsPath } };
}

test('creates an empty JSON workspace scaffold', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'multica-manager-')); const target = join(temp, 'demo');
  await createProject(target, 'demo');
  const packageJson = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  const agentsTemplate = await readFile(new URL('../templates/AGENTS.md', import.meta.url), 'utf8');
  assert.equal(packageJson.scripts['workspace:pull'], 'multica-cli-manager workspace pull');
  assert.equal(await readFile(join(target, 'src/workspaces/.gitkeep'), 'utf8'), '');
  const readme = await readFile(join(target, 'README.md'), 'utf8');
  assert.match(readme, /^# demo$/m);
  assert.doesNotMatch(readme, /\{\{PROJECT_NAME\}\}/);
  assert.match(readme, /preview-only/);
  assert.equal(await readFile(join(target, 'AGENTS.md'), 'utf8'), agentsTemplate);
  assert.match(await readFile(join(target, '.gitignore'), 'utf8'), /^node_modules\/$/m);
});

test('normalization compares JSON semantically and ignores excluded fields and trailing newlines', () => {
  const remote = { id: agentId, name: 'Planner', description: 'Plans', status: 'idle' };
  assert.deepEqual(pick(remote, AGENT_FIELDS), { id: agentId, name: 'Planner', description: 'Plans' });
  assert.deepEqual(changedFields({ name: 'Planner' }, remote, ['name']), []);
  assert.equal(normalizeText('text\n\n'), normalizeText('text'));
});

test('pull writes minimal JSON, markdown, and nested Skill files', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try { await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' }); } finally { process.env = old; }
  const base = join(f.root, 'src/workspaces/demo');
  const agent = JSON.parse(await readFile(join(base, 'agents/planner/agent.json'), 'utf8'));
  assert.deepEqual(Object.keys(agent), AGENT_FIELDS);
  assert.equal(JSON.stringify(agent).includes('secret'), false);
  assert.equal(await readFile(join(base, 'agents/planner/instructions.md'), 'utf8'), 'Plan.\n');
  assert.equal(await readFile(join(base, 'skills/guide/references/a.md'), 'utf8'), 'A\n');
  assert.deepEqual(JSON.parse(await readFile(join(base, 'projects/roadmap/project.json'), 'utf8')), { id: projectId, title: 'Roadmap', description: 'Work', status: 'planned' });
});

test('push dry-run makes no writes, then defaults to field-level update and verification', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try {
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
    const base = join(f.root, 'src/workspaces/demo');
    const agentPath = join(base, 'agents/planner/agent.json'); const agent = JSON.parse(await readFile(agentPath, 'utf8')); agent.description = 'Changed'; await writeFile(agentPath, JSON.stringify(agent, null, 2) + '\n');
    await writeFile(join(base, 'agents/planner/instructions.md'), 'New plan.\n');
    await writeFile(join(base, 'skills/guide/references/a.md'), 'B\n');
    const before = (await readFile(f.callsPath, 'utf8')).trim().split('\n').length;
    await syncWorkspace({ root: f.root, action: 'push', workspace: 'demo', dryRun: true });
    const previewCalls = (await readFile(f.callsPath, 'utf8')).trim().split('\n').slice(before).map(JSON.parse);
    assert.equal(previewCalls.some((args) => ['update', 'upsert', 'delete', 'create', 'archive', 'restore'].includes(args[1]) || args[2] === 'upsert'), false);
    await syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' });
    const state = JSON.parse(await readFile(f.statePath, 'utf8'));
    assert.equal(state.agents[0].description, 'Changed'); assert.equal(state.agents[0].instructions, 'New plan.\n');
    assert.equal(state.skills[0].files[0].content, 'B\n');
    const calls = (await readFile(f.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.some((args) => args[0] === 'skill' && args[1] === 'files' && args[2] === 'upsert'), true);
    const agentUpdate = calls.find((args) => args[0] === 'agent' && args[1] === 'update');
    assert.equal(agentUpdate.includes('--description'), true);
    assert.equal(agentUpdate.includes('--instructions'), true);
    assert.equal(agentUpdate.includes('--model'), false);
    assert.equal(calls.some((args) => ['create', 'delete', 'archive', 'restore'].includes(args[1]) || args[2] === 'delete'), false);
  } finally { process.env = old; }
});

test('push rejects a missing or invalid resource id before writes', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try {
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
    const path = join(f.root, 'src/workspaces/demo/agents/planner/agent.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.id = 'invalid'; await writeFile(path, JSON.stringify(value));
    await assert.rejects(syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' }), /valid remote id/);
  } finally { process.env = old; }
});

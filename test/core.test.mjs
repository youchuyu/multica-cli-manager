import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../src/commands/create-project.mjs';
import { changedFields, normalizeText, pick, secretFingerprint, AGENT_FIELDS } from '../src/workspace/format.mjs';
import { plan } from '../src/workspace/plan.mjs';
import { syncWorkspace } from '../src/commands/workspace-sync.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const skillId = '33333333-3333-4333-8333-333333333333';
const projectId = '44444444-4444-4444-8444-444444444444';
const projectResourceId = '55555555-5555-4555-8555-555555555555';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multica-sync-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const statePath = join(root, 'state.json'); const callsPath = join(root, 'calls.jsonl');
  await writeFile(statePath, JSON.stringify({
    workspace: { id: workspaceId, name: 'Demo', slug: 'demo', description: 'excluded' },
    agents: [{ id: agentId, name: 'Planner', description: 'Plans', runtime_id: 'runtime', model: 'gpt-5', thinking_level: 'medium', service_tier: '', permission_mode: 'private', max_concurrent_tasks: 6, custom_args: [], runtime_config: {}, mcp_config: null, skill_ids: [skillId], instructions: 'Plan.\n', custom_env: { TOKEN: 'secret' }, status: 'idle' }],
    skills: [{ id: skillId, name: 'Guide', description: 'Routes work', content: '# Guide\n', config: { hidden: true }, files: [{ path: 'references/a.md', content: 'A\n' }] }],
    projects: [{ id: projectId, title: 'Roadmap', description: 'Work', status: 'planned', priority: 'high', resources: [{ id: projectResourceId, project_id: projectId, workspace_id: workspaceId, resource_type: 'github_repo', resource_ref: { url: 'https://example.com/roadmap.git' }, label: null, position: 0, created_at: 'ignored' }] }],
    squads: []
  }));
  const executable = `#!/usr/bin/env node
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
const statePath = process.env.FAKE_MULTICA_STATE; const callsPath = process.env.FAKE_MULTICA_CALLS;
const state = JSON.parse(readFileSync(statePath, 'utf8')); const args = process.argv.slice(2);
appendFileSync(callsPath, JSON.stringify(args) + '\\n');
const positional = args.filter((v, i) => !v.startsWith('--') && !['--profile','--workspace-id','--output','--name','--description','--instructions','--runtime-id','--model','--thinking-level','--service-tier','--permission-mode','--max-concurrent-tasks','--custom-args','--runtime-config','--mcp-config','--skill-ids','--title','--status','--path'].includes(args[i-1]));
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const input = readFileSync(0, 'utf8'); let result; let mutated = false;
if (args[0] === 'workspace' && args[1] === 'get') result = state.workspace;
else if (args[1] === 'list' && ['agent','skill','project'].includes(args[0])) result = state[args[0] + 's'].map(({id,name,title}) => ({id,name,title}));
else if (args[0] === 'squad' && args[1] === 'list') result = state.squads.map(({id,name}) => ({id,name}));
else if (args[0] === 'agent' && args[1] === 'env' && args[2] === 'get') result = {agent_id:args[3],custom_env:state.agents.find(x => x.id === args[3]).custom_env || {}};
else if (args[0] === 'agent' && args[1] === 'env' && args[2] === 'set') { const x=state.agents.find(x=>x.id===args[3]); x.custom_env=JSON.parse(input); mutated=true; result=x.custom_env; }
else if (args[0] === 'agent' && args[1] === 'skills' && args[2] === 'list') result = (state.agents.find(x => x.id === args[3]).skill_ids || []).map(id => state.skills.find(skill => skill.id === id)).filter(Boolean);
else if (args[0] === 'agent' && args[1] === 'skills' && args[2] === 'set') { const x=state.agents.find(x=>x.id===args[3]); x.skill_ids=(option('--skill-ids') || '').split(',').filter(Boolean); mutated=true; result=x.skill_ids; }
else if (args[0] === 'skill' && args[1] === 'files' && args[2] === 'list') { const files = state.skills.find(x => x.id === args[3]).files; result = args.includes('--with-content') ? files : files.map(({path,id}) => ({path,id})); }
else if (args[0] === 'project' && args[1] === 'resource' && args[2] === 'list') result = state.projects.find(x => x.id === args[3]).resources;
else if (args[0] === 'project' && args[1] === 'resource' && args[2] === 'add') { const x=state.projects.find(x=>x.id===args[3]); const resource={id:'66666666-6666-4666-8666-666666666666',resource_type:option('--type'),resource_ref:JSON.parse(option('--ref')),label:option('--label')??null}; x.resources.push(resource); mutated=true; result=resource; }
else if (args[0] === 'project' && args[1] === 'resource' && args[2] === 'update') { const x=state.projects.find(x=>x.id===args[3]); const resource=x.resources.find(r=>r.id===args[4]); resource.resource_ref=JSON.parse(option('--ref')); resource.label=args.includes('--clear-label')?null:option('--label'); mutated=true; result=resource; }
else if (args[0] === 'project' && args[1] === 'resource' && args[2] === 'remove') { const x=state.projects.find(x=>x.id===args[3]); x.resources=x.resources.filter(r=>r.id!==args[4]); mutated=true; result={}; }
else if (args[0] === 'agent' && args[1] === 'create') { const x={id:'77777777-7777-4777-8777-777777777777',name:option('--name'),description:option('--description'),runtime_id:option('--runtime-id'),model:option('--model'),thinking_level:option('--thinking-level'),service_tier:option('--service-tier'),permission_mode:option('--permission-mode'),max_concurrent_tasks:Number(option('--max-concurrent-tasks')),custom_args:JSON.parse(option('--custom-args')),runtime_config:JSON.parse(option('--runtime-config')),mcp_config:args.includes('--mcp-config')?JSON.parse(option('--mcp-config')):null,skill_ids:[],custom_env:{},instructions:option('--instructions')}; state.agents.push(x); mutated=true; result=x; }
else if (args[0] === 'skill' && args[1] === 'create') { const x={id:'88888888-8888-4888-8888-888888888888',name:option('--name'),description:option('--description'),content:input,files:[]}; state.skills.push(x); mutated=true; result=x; }
else if (args[0] === 'project' && args[1] === 'create') { const x={id:'99999999-9999-4999-8999-999999999999',title:option('--title'),description:option('--description'),status:option('--status'),resources:[]}; state.projects.push(x); mutated=true; result=x; }
else if (args[0] === 'skill' && args[1] === 'get') { const skill = state.skills.find(x => x.id === args[2]); result = args.includes('--with-content') ? skill : (({content,files,...metadata}) => metadata)(skill); }
else if (args[1] === 'get') result = state[args[0] + 's'].find(x => x.id === args[2]);
else if (args[0] === 'agent' && args[1] === 'update') { const x = state.agents.find(x => x.id === args[2]); for (const [flag,key] of [['--name','name'],['--description','description'],['--instructions','instructions'],['--runtime-id','runtime_id'],['--model','model'],['--thinking-level','thinking_level'],['--service-tier','service_tier'],['--permission-mode','permission_mode']]) if (args.includes(flag)) x[key] = option(flag); if (args.includes('--max-concurrent-tasks')) x.max_concurrent_tasks = Number(option('--max-concurrent-tasks')); for (const [flag,key] of [['--custom-args','custom_args'],['--runtime-config','runtime_config'],['--mcp-config','mcp_config']]) if(args.includes(flag)) x[key]=JSON.parse(option(flag)); mutated=true; result=x; }
else if (args[0] === 'skill' && args[1] === 'update') { const x=state.skills.find(x=>x.id===args[2]); if(args.includes('--name')) x.name=option('--name'); if(args.includes('--description')) x.description=option('--description'); if(args.includes('--content-stdin')) x.content=input; mutated=true; result=x; }
else if (args[0] === 'skill' && args[1] === 'files' && args[2] === 'upsert') { const x=state.skills.find(x=>x.id===args[3]); const path=option('--path'); const file=x.files.find(f=>f.path===path); if(file) file.content=input; else x.files.push({path,content:input}); mutated=true; result={path}; }
else if (args[0] === 'project' && args[1] === 'update') { const x=state.projects.find(x=>x.id===args[2]); for (const [flag,key] of [['--title','title'],['--description','description'],['--status','status']]) if (args.includes(flag)) x[key]=option(flag); mutated=true; result=x; }
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
  assert.equal(secretFingerprint({ TOKEN: 'value', HOST: 'example' }), secretFingerprint({ HOST: 'example', TOKEN: 'value' }));
});

test('plan treats fields missing from an older baseline as schema migration fields', () => {
  const baseAgent = { id: agentId, name: 'Planner', description: 'Plans', runtime_id: 'runtime', model: 'gpt-5', thinking_level: 'medium', permission_mode: 'private', max_concurrent_tasks: 6, instructions: 'Plan.' };
  const targetAgent = { ...baseAgent, service_tier: '', custom_args: [], runtime_config: {}, mcp_config: null, skill_ids: [], custom_env: {} };
  const sourceAgent = { ...targetAgent, skill_ids: [skillId] };
  const snapshot = (agent) => ({ workspace: { id: workspaceId }, items: { workspace: [], agent: [agent], skill: [], project: [] } });
  const baseline = { resources: { [`agent:${agentId}`]: baseAgent } };
  const result = plan('push', snapshot(sourceAgent), snapshot(targetAgent), baseline, false);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.operations.find((op) => op.resource_type === 'agent').fields, ['skill_ids']);
});

test('pull writes minimal JSON, markdown, and nested Skill files', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try { await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' }); } finally { process.env = old; }
  const base = join(f.root, 'src/workspaces/demo');
  const agent = JSON.parse(await readFile(join(base, 'agents/planner/agent.json'), 'utf8'));
  assert.deepEqual(Object.keys(agent), AGENT_FIELDS);
  assert.equal(JSON.stringify(agent).includes('secret'), false);
  assert.deepEqual(JSON.parse(await readFile(join(base, 'agents/planner/custom-env.json'), 'utf8')), { TOKEN: 'secret' });
  assert.deepEqual(agent.skill_ids, [skillId]);
  assert.equal(await readFile(join(base, 'agents/planner/instructions.md'), 'utf8'), 'Plan.\n');
  assert.equal(await readFile(join(base, 'skills/guide/references/a.md'), 'utf8'), 'A\n');
  const calls = (await readFile(f.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const skillGet = calls.find((args) => args[0] === 'skill' && args[1] === 'get');
  const skillFiles = calls.find((args) => args[0] === 'skill' && args[1] === 'files' && args[2] === 'list');
  assert.equal(skillGet.includes('--with-content'), true);
  assert.equal(skillFiles.includes('--with-content'), true);
  assert.deepEqual(JSON.parse(await readFile(join(base, 'projects/roadmap/project.json'), 'utf8')), { id: projectId, title: 'Roadmap', description: 'Work', status: 'planned' });
  assert.deepEqual(JSON.parse(await readFile(join(base, 'projects/roadmap/resources.json'), 'utf8')), [{ id: projectResourceId, resource_type: 'github_repo', resource_ref: { url: 'https://example.com/roadmap.git' }, label: null }]);
});

test('push dry-run makes no writes, then defaults to field-level update and verification', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try {
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
    const base = join(f.root, 'src/workspaces/demo');
    const agentPath = join(base, 'agents/planner/agent.json'); const agent = JSON.parse(await readFile(agentPath, 'utf8')); agent.description = 'Changed'; await writeFile(agentPath, JSON.stringify(agent, null, 2) + '\n');
    await writeFile(join(base, 'agents/planner/instructions.md'), 'New plan.\n');
    await writeFile(join(base, 'skills/guide/references/a.md'), 'B\n');
    const resourcesPath = join(base, 'projects/roadmap/resources.json'); const resources = JSON.parse(await readFile(resourcesPath, 'utf8')); resources.push({ resource_ref: { url: 'https://example.com/new.git' } }); await writeFile(resourcesPath, JSON.stringify(resources, null, 2) + '\n');
    const before = (await readFile(f.callsPath, 'utf8')).trim().split('\n').length;
    await syncWorkspace({ root: f.root, action: 'push', workspace: 'demo', dryRun: true });
    const previewCalls = (await readFile(f.callsPath, 'utf8')).trim().split('\n').slice(before).map(JSON.parse);
    assert.equal(previewCalls.some((args) => ['update', 'upsert', 'delete', 'create', 'archive', 'restore'].includes(args[1]) || args[2] === 'upsert'), false);
    await syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' });
    const state = JSON.parse(await readFile(f.statePath, 'utf8'));
    assert.equal(state.agents[0].description, 'Changed'); assert.equal(state.agents[0].instructions, 'New plan.\n');
    assert.equal(state.skills[0].files[0].content, 'B\n');
    assert.equal(state.projects[0].resources.some((resource) => resource.resource_ref.url === 'https://example.com/new.git' && resource.resource_type === 'github_repo'), true);
    const calls = (await readFile(f.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.some((args) => args[0] === 'skill' && args[1] === 'files' && args[2] === 'upsert'), true);
    const agentUpdate = calls.find((args) => args[0] === 'agent' && args[1] === 'update');
    assert.equal(agentUpdate.includes('--description'), true);
    assert.equal(agentUpdate.includes('--instructions'), true);
    assert.equal(agentUpdate.includes('--model'), false);
    assert.equal(calls.some((args) => ['create', 'delete', 'archive', 'restore'].includes(args[1]) || args[2] === 'delete'), false);
  } finally { process.env = old; }
});

test('push exactly replaces existing Agent custom env and Skill assignments without printing values', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  const output = []; const originalLog = console.log; console.log = (value) => output.push(String(value));
  try {
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
    const base = join(f.root, 'src/workspaces/demo/agents/planner');
    const agentPath = join(base, 'agent.json'); const agent = JSON.parse(await readFile(agentPath, 'utf8'));
    agent.skill_ids = []; await writeFile(agentPath, JSON.stringify(agent, null, 2) + '\n');
    await writeFile(join(base, 'custom-env.json'), JSON.stringify({ NEXT_TOKEN: 'replacement-secret' }, null, 2) + '\n');
    await syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' });
    const state = JSON.parse(await readFile(f.statePath, 'utf8'));
    assert.deepEqual(state.agents[0].skill_ids, []);
    assert.deepEqual(state.agents[0].custom_env, { NEXT_TOKEN: 'replacement-secret' });
    assert.equal(output.join('\n').includes('replacement-secret'), false);
    const calls = (await readFile(f.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'skills' && args[2] === 'set'), true);
    assert.equal(calls.some((args) => args[0] === 'agent' && args[1] === 'env' && args[2] === 'set' && args.includes('--custom-env-stdin')), true);
  } finally { console.log = originalLog; process.env = old; }
});

test('push creates Agent, Skill, Project, their files, and Project resources', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try {
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
    const base = join(f.root, 'src/workspaces/demo');
    const newAgentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newSkillId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const newProjectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const newResourceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await mkdir(join(base, 'agents/executor'));
    await writeFile(join(base, 'agents/executor/agent.json'), JSON.stringify({ id: newAgentId, name: 'Executor', description: 'Executes', runtime_id: 'runtime', model: 'gpt-5', thinking_level: 'medium', service_tier: '', permission_mode: 'private', max_concurrent_tasks: 2, custom_args: ['--verbose'], runtime_config: { mode: 'test' }, mcp_config: null, skill_ids: [newSkillId] }, null, 2));
    await writeFile(join(base, 'agents/executor/instructions.md'), 'Execute.\n');
    await writeFile(join(base, 'agents/executor/custom-env.json'), JSON.stringify({ TOKEN: 'new-secret' }));
    await mkdir(join(base, 'skills/checker/references'), { recursive: true });
    await writeFile(join(base, 'skills/checker/skill.json'), JSON.stringify({ id: newSkillId, name: 'Checker', description: 'Checks' }, null, 2));
    await writeFile(join(base, 'skills/checker/SKILL.md'), '# Checker\n');
    await writeFile(join(base, 'skills/checker/references/check.md'), 'Check.\n');
    await mkdir(join(base, 'projects/release'));
    await writeFile(join(base, 'projects/release/project.json'), JSON.stringify({ id: newProjectId, title: 'Release', description: 'Ship', status: 'planned' }, null, 2));
    await writeFile(join(base, 'projects/release/resources.json'), JSON.stringify([{ id: newResourceId, resource_type: 'github_repo', resource_ref: { url: 'https://example.com/release.git' }, label: 'Release repo' }], null, 2));
    await syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' });
    const state = JSON.parse(await readFile(f.statePath, 'utf8'));
    assert.equal(state.agents.some((item) => item.name === 'Executor'), true);
    assert.deepEqual(state.agents.find((item) => item.name === 'Executor').skill_ids, ['88888888-8888-4888-8888-888888888888']);
    assert.deepEqual(state.agents.find((item) => item.name === 'Executor').custom_env, { TOKEN: 'new-secret' });
    assert.equal(state.skills.find((item) => item.name === 'Checker').files[0].path, 'references/check.md');
    assert.equal(state.projects.find((item) => item.title === 'Release').resources[0].resource_ref.url, 'https://example.com/release.git');
    assert.equal(JSON.parse(await readFile(join(base, 'agents/executor/agent.json'), 'utf8')).id, '77777777-7777-4777-8777-777777777777');
    assert.equal(JSON.parse(await readFile(join(base, 'skills/checker/skill.json'), 'utf8')).id, '88888888-8888-4888-8888-888888888888');
    assert.equal(JSON.parse(await readFile(join(base, 'projects/release/project.json'), 'utf8')).id, '99999999-9999-4999-8999-999999999999');
    assert.equal(JSON.parse(await readFile(join(base, 'projects/release/resources.json'), 'utf8'))[0].id, '66666666-6666-4666-8666-666666666666');
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

test('push renames Agent, Skill, and Project directories to match changed names', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try {
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
    const base = join(f.root, 'src/workspaces/demo');
    for (const [path, field, name] of [
      ['agents/planner/agent.json', 'name', 'Lead Planner'],
      ['skills/guide/skill.json', 'name', 'Routing Guide'],
      ['projects/roadmap/project.json', 'title', 'Product Roadmap'],
    ]) {
      const file = join(base, path); const value = JSON.parse(await readFile(file, 'utf8'));
      value[field] = name; await writeFile(file, JSON.stringify(value, null, 2) + '\n');
    }
    await syncWorkspace({ root: f.root, action: 'push', workspace: 'demo', dryRun: true });
    await stat(join(base, 'agents/planner/agent.json'));
    await syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' });
    await stat(join(base, 'agents/lead-planner/agent.json'));
    await stat(join(base, 'skills/routing-guide/skill.json'));
    await stat(join(base, 'projects/product-roadmap/project.json'));
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
  } finally { process.env = old; }
});

test('push rejects a slug rename when the target directory exists', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try {
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
    const base = join(f.root, 'src/workspaces/demo/agents');
    const path = join(base, 'planner/agent.json'); const value = JSON.parse(await readFile(path, 'utf8'));
    value.name = 'Existing'; await writeFile(path, JSON.stringify(value, null, 2) + '\n');
    await mkdir(join(base, 'existing'));
    await assert.rejects(syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' }), /slug target already exists/);
    const state = JSON.parse(await readFile(f.statePath, 'utf8'));
    assert.equal(state.agents[0].name, 'Planner');
  } finally { process.env = old; }
});

test('rejects duplicate Project resource identities before writes', async () => {
  const f = await fixture(); const old = { ...process.env }; Object.assign(process.env, f.env);
  try {
    await syncWorkspace({ root: f.root, action: 'pull', workspace: 'demo' });
    const path = join(f.root, 'src/workspaces/demo/projects/roadmap/resources.json');
    const resource = JSON.parse(await readFile(path, 'utf8'))[0];
    await writeFile(path, JSON.stringify([resource, resource]));
    await assert.rejects(syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' }), /duplicate project resource id/);
    await writeFile(path, JSON.stringify([{ resource_ref: { url: 'https://example.com/new.git' } }, { resource_ref: { url: 'https://example.com/new.git' } }]));
    await assert.rejects(syncWorkspace({ root: f.root, action: 'push', workspace: 'demo' }), /duplicate new project resource/);
  } finally { process.env = old; }
});

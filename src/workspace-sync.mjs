import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { listItems, runMultica } from './multica-cli.mjs';
import { agentMarkdown, parseAgent, slugify } from './workspace-format.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const write = async (path, content) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };

async function resolveRemote(identifier, profile) {
  if (!identifier) throw new Error('--workspace <slug|id> is required');
  const workspace = await runMultica(['workspace', 'get', identifier], { profile });
  return { workspace, id: workspace.id, slug: workspace.slug ?? slugify(workspace.name) };
}

async function pull({ root, workspace: identifier, profile }) {
  const remote = await resolveRemote(identifier, profile);
  const dir = join(root, 'src/workspace', remote.slug);
  const [agents, skills, projects] = await Promise.all([
    runMultica(['agent', 'list'], { profile, workspaceId: remote.id }),
    runMultica(['skill', 'list'], { profile, workspaceId: remote.id }),
    runMultica(['project', 'list'], { profile, workspaceId: remote.id })
  ]);
  const resources = { agents: {}, skills: {}, projects: {} };
  await write(join(dir, 'workspace.yaml'), yaml.dump({ workspace: { name: remote.workspace.name, slug: remote.slug, id: remote.id } }, { lineWidth: -1 }));
  for (const summary of listItems(agents)) { const item = await runMultica(['agent', 'get', summary.id], { profile, workspaceId: remote.id }); resources.agents[item.name] = item.id; await write(join(dir, 'agents', `${slugify(item.name)}.md`), agentMarkdown(item)); }
  for (const summary of listItems(skills)) { const item = await runMultica(['skill', 'get', summary.id], { profile, workspaceId: remote.id }); resources.skills[item.name] = item.id; const skillDir = join(dir, 'skills', slugify(item.name)); await write(join(skillDir, 'SKILL.md'), item.content ?? ''); for (const file of item.files ?? []) await write(join(skillDir, file.path), file.content ?? ''); }
  for (const summary of listItems(projects)) { const item = await runMultica(['project', 'get', summary.id], { profile, workspaceId: remote.id }); const name = item.title ?? item.name; resources.projects[name] = item.id; await write(join(dir, 'projects', slugify(name), 'project.yaml'), yaml.dump({ project: item }, { lineWidth: -1, noRefs: true })); }
  await write(join(dir, 'resources.json'), JSON.stringify(resources, null, 2) + '\n');
  console.log(`Pulled workspace ${remote.slug}: ${Object.keys(resources.agents).length} agents, ${Object.keys(resources.skills).length} skills, ${Object.keys(resources.projects).length} projects.`);
}

async function localSnapshot(root, identifier) {
  const workspaceRoot = join(root, 'src/workspace');
  const candidates = await readdir(workspaceRoot).catch(() => []);
  for (const name of candidates) { const dir = join(workspaceRoot, name); try { const config = yaml.load(await readFile(join(dir, 'workspace.yaml'), 'utf8')); const ws = config.workspace ?? {}; if ([name, ws.slug, ws.id].includes(identifier)) return { dir, workspace: ws, resources: await json(join(dir, 'resources.json')) }; } catch {} }
  throw new Error(`local workspace snapshot not found for ${identifier}; run workspace pull first`);
}

async function inspectLocal(snapshot, profile) {
  const changes = [];
  for (const [name, id] of Object.entries(snapshot.resources.agents ?? {})) { const local = parseAgent(await readFile(join(snapshot.dir, 'agents', `${slugify(name)}.md`), 'utf8')); const remote = await runMultica(['agent', 'get', id], { profile, workspaceId: snapshot.workspace.id }); const fields = ['description', 'model', 'permission_mode', 'visibility', 'max_concurrent_tasks', 'runtime_id', 'thinking_level'].filter((key) => String(local.fields[key] ?? '') !== String(remote[key] ?? '')); if (local.instructions.trimEnd() !== String(remote.instructions ?? '').trimEnd()) fields.push('instructions'); if (fields.length) changes.push({ type: 'agent', name, id, fields, local }); }
  for (const [name, id] of Object.entries(snapshot.resources.skills ?? {})) { const content = await readFile(join(snapshot.dir, 'skills', slugify(name), 'SKILL.md'), 'utf8'); const remote = await runMultica(['skill', 'get', id], { profile, workspaceId: snapshot.workspace.id }); if (content.trimEnd() !== String(remote.content ?? '').trimEnd()) changes.push({ type: 'skill', name, id, fields: ['content'], content }); }
  for (const [name, id] of Object.entries(snapshot.resources.projects ?? {})) { const local = yaml.load(await readFile(join(snapshot.dir, 'projects', slugify(name), 'project.yaml'), 'utf8')).project ?? {}; const remote = await runMultica(['project', 'get', id], { profile, workspaceId: snapshot.workspace.id }); const fields = ['title', 'description', 'status', 'icon', 'lead', 'start_date', 'due_date'].filter((key) => String(local[key] ?? '') !== String(remote[key] ?? '')); if (fields.length) changes.push({ type: 'project', name, id, fields, local }); }
  for (const change of changes) console.log(`${change.type} ${change.name}: ${change.fields.join(', ')}`);
  if (!changes.length) console.log('No differences.');
  return changes;
}

async function diff(options) { const snapshot = await localSnapshot(options.root, options.workspace); await inspectLocal(snapshot, options.profile); }

async function push(options) {
  const snapshot = await localSnapshot(options.root, options.workspace);
  const changes = await inspectLocal(snapshot, options.profile);
  if (!options.apply) { console.log(`Dry run: ${changes.length} resource(s) would be updated. Add --apply to continue.`); return; }
  for (const change of changes) {
    if (change.type === 'agent') { const f = change.local.fields; await runMultica(['agent', 'update', change.id, '--name', f.name, '--description', f.description ?? '', '--instructions', change.local.instructions, '--model', f.model ?? '', '--permission-mode', f.permission_mode ?? '', '--max-concurrent-tasks', String(f.max_concurrent_tasks ?? 6), '--runtime-id', f.runtime_id ?? '', '--thinking-level', f.thinking_level ?? ''], { profile: options.profile, workspaceId: snapshot.workspace.id }); }
    if (change.type === 'skill') await runMultica(['skill', 'update', change.id, '--content-stdin'], { profile: options.profile, workspaceId: snapshot.workspace.id, input: change.content });
    if (change.type === 'project') { const p = change.local; const args = ['project', 'update', change.id, '--title', p.title ?? change.name, '--description', p.description ?? '']; if (p.status) args.push('--status', p.status); if (p.icon) args.push('--icon', p.icon); if (p.lead) args.push('--lead', p.lead); await runMultica(args, { profile: options.profile, workspaceId: snapshot.workspace.id }); }
  }
  console.log(`Updated ${changes.length} resource(s).`);
}

export async function syncWorkspace(options) {
  if (options.action === 'pull') return pull(options);
  if (options.action === 'diff') return diff(options);
  if (options.action === 'push') return push(options);
}

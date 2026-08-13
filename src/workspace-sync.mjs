import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { listItems, runMultica } from './multica-cli.mjs';
import {
  AGENT_FIELDS, PROJECT_FIELDS, SKILL_FIELDS, WORKSPACE_FIELDS,
  changedFields, formattedJson, normalizeText, pick, safeRelativePath, slugify
} from './workspace-format.mjs';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const write = async (path, content) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
const resourceId = (value, path) => {
  if (typeof value?.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)) throw new Error(`${path} must contain a valid remote id`);
  return value.id;
};

function skillFiles(value) {
  const files = Array.isArray(value?.files) ? value.files : listItems(value);
  return Object.fromEntries(files.filter((file) => file?.path && file.path !== 'SKILL.md').map((file) => [file.path, normalizeText(file.content)]));
}

async function remoteSkill(id, options) {
  const detail = await runMultica(['skill', 'get', id], options);
  const listed = await runMultica(['skill', 'files', 'list', id], options);
  return { ...detail, files: listItems(listed).length ? listItems(listed) : detail.files ?? [] };
}

async function resolveRemote(identifier, profile) {
  if (!identifier) throw new Error('--workspace <slug|id> is required');
  const workspace = await runMultica(['workspace', 'get', identifier], { profile });
  return { workspace, id: workspace.id, slug: workspace.slug ?? slugify(workspace.name) };
}

async function walkFiles(root, dir = root) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function localSkillFiles(dir) {
  const result = {};
  for (const path of await walkFiles(dir)) {
    const name = safeRelativePath(dir, path);
    if (name === 'skill.json' || name === 'SKILL.md') continue;
    result[name] = normalizeText(await readFile(path, 'utf8'));
  }
  return result;
}

async function reportExtraDirectories(parent, expected, type) {
  for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !expected.has(entry.name)) console.warn(`Local ${type} directory not present remotely; kept unchanged: ${entry.name}`);
  }
}

async function pull({ root, workspace: identifier, profile }) {
  const remote = await resolveRemote(identifier, profile);
  const dir = join(root, 'src/workspaces', remote.slug);
  const [agents, skills, projects] = await Promise.all([
    runMultica(['agent', 'list'], { profile, workspaceId: remote.id }),
    runMultica(['skill', 'list'], { profile, workspaceId: remote.id }),
    runMultica(['project', 'list'], { profile, workspaceId: remote.id })
  ]);
  await reportExtraDirectories(join(dir, 'agents'), new Set(listItems(agents).map((item) => slugify(item.name))), 'Agent');
  await reportExtraDirectories(join(dir, 'skills'), new Set(listItems(skills).map((item) => slugify(item.name))), 'Skill');
  await reportExtraDirectories(join(dir, 'projects'), new Set(listItems(projects).map((item) => slugify(item.title ?? item.name))), 'Project');
  await write(join(dir, 'workspace.json'), formattedJson(pick({ ...remote.workspace, slug: remote.slug }, WORKSPACE_FIELDS)));
  for (const summary of listItems(agents)) {
    const item = await runMultica(['agent', 'get', summary.id], { profile, workspaceId: remote.id });
    const agentDir = join(dir, 'agents', slugify(item.name));
    await write(join(agentDir, 'agent.json'), formattedJson(pick(item, AGENT_FIELDS)));
    await write(join(agentDir, 'instructions.md'), String(item.instructions ?? ''));
  }
  for (const summary of listItems(skills)) {
    const item = await remoteSkill(summary.id, { profile, workspaceId: remote.id });
    const skillDir = join(dir, 'skills', slugify(item.name));
    await write(join(skillDir, 'skill.json'), formattedJson(pick(item, SKILL_FIELDS)));
    await write(join(skillDir, 'SKILL.md'), String(item.content ?? ''));
    for (const file of item.files ?? []) {
      if (!file.path || file.path === 'SKILL.md') continue;
      const target = resolve(skillDir, file.path);
      if (!target.startsWith(`${resolve(skillDir)}${sep}`)) throw new Error(`unsafe Skill file path: ${file.path}`);
      await write(target, String(file.content ?? ''));
    }
  }
  for (const summary of listItems(projects)) {
    const item = await runMultica(['project', 'get', summary.id], { profile, workspaceId: remote.id });
    const projectDir = join(dir, 'projects', slugify(item.title ?? item.name));
    await write(join(projectDir, 'project.json'), formattedJson(pick(item, PROJECT_FIELDS)));
  }
  const counts = [listItems(agents).length, listItems(skills).length, listItems(projects).length];
  console.log(`Pulled workspace ${remote.slug}: ${counts[0]} agents, ${counts[1]} skills, ${counts[2]} projects.`);
}

async function resourceDirs(parent, file) {
  const result = [];
  for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dir = join(parent, entry.name);
    try { await stat(join(dir, file)); result.push(dir); } catch {}
  }
  return result;
}

async function localSnapshot(root, identifier) {
  const workspaceRoot = join(root, 'src/workspaces');
  for (const name of await readdir(workspaceRoot).catch(() => [])) {
    const dir = join(workspaceRoot, name);
    try {
      const workspace = await readJson(join(dir, 'workspace.json'));
      if ([name, workspace.slug, workspace.id].includes(identifier)) return { dir, workspace };
    } catch {}
  }
  throw new Error(`local workspace snapshot not found for ${identifier}; run workspace pull first`);
}

async function inspectLocal(snapshot, profile, { print = true } = {}) {
  resourceId(snapshot.workspace, join(snapshot.dir, 'workspace.json'));
  const cli = { profile, workspaceId: snapshot.workspace.id };
  const changes = [];
  for (const dir of await resourceDirs(join(snapshot.dir, 'agents'), 'agent.json')) {
    const path = join(dir, 'agent.json'); const local = await readJson(path); const id = resourceId(local, path);
    const remote = await runMultica(['agent', 'get', id], cli);
    const fields = changedFields(local, remote, AGENT_FIELDS.filter((field) => field !== 'id'));
    const instructions = await readFile(join(dir, 'instructions.md'), 'utf8');
    if (normalizeText(instructions) !== normalizeText(remote.instructions)) fields.push('instructions');
    if (fields.length) changes.push({ type: 'agent', name: local.name, id, fields, local, instructions });
  }
  for (const dir of await resourceDirs(join(snapshot.dir, 'skills'), 'skill.json')) {
    const path = join(dir, 'skill.json'); const local = await readJson(path); const id = resourceId(local, path);
    const remote = await remoteSkill(id, cli);
    const fields = changedFields(local, remote, SKILL_FIELDS.filter((field) => field !== 'id'));
    const content = await readFile(join(dir, 'SKILL.md'), 'utf8');
    if (normalizeText(content) !== normalizeText(remote.content)) fields.push('content');
    const localFiles = await localSkillFiles(dir); const remoteFiles = skillFiles(remote);
    const files = Object.keys(localFiles).filter((name) => localFiles[name] !== remoteFiles[name]);
    if (files.length) fields.push(...files.map((name) => `file:${name}`));
    if (fields.length) changes.push({ type: 'skill', name: local.name, id, fields, local, content, files, localFiles });
  }
  for (const dir of await resourceDirs(join(snapshot.dir, 'projects'), 'project.json')) {
    const path = join(dir, 'project.json'); const local = await readJson(path); const id = resourceId(local, path);
    const remote = await runMultica(['project', 'get', id], cli);
    const fields = changedFields(local, remote, PROJECT_FIELDS.filter((field) => field !== 'id'));
    if (fields.length) changes.push({ type: 'project', name: local.title, id, fields, local });
  }
  if (print) {
    for (const change of changes) console.log(`${change.type} ${change.name}: ${change.fields.join(', ')}`);
    if (!changes.length) console.log('No differences.');
  }
  return changes;
}

async function diff(options) { return inspectLocal(await localSnapshot(options.root, options.workspace), options.profile); }

async function push(options) {
  const snapshot = await localSnapshot(options.root, options.workspace);
  const changes = await inspectLocal(snapshot, options.profile);
  if (!options.apply) { console.log(`Preview: ${changes.length} resource(s) would be updated. Add --apply to continue.`); return; }
  const cli = { profile: options.profile, workspaceId: snapshot.workspace.id };
  for (const change of changes) {
    if (change.type === 'agent') {
      const a = change.local;
      await runMultica(['agent', 'update', change.id, '--name', a.name, '--description', a.description ?? '', '--instructions', change.instructions, '--runtime-id', a.runtime_id ?? '', '--model', a.model ?? '', '--thinking-level', a.thinking_level ?? '', '--permission-mode', a.permission_mode ?? '', '--max-concurrent-tasks', String(a.max_concurrent_tasks)], cli);
    }
    if (change.type === 'skill') {
      const s = change.local;
      await runMultica(['skill', 'update', change.id, '--name', s.name, '--description', s.description ?? '', '--content-stdin'], { ...cli, input: change.content });
      for (const path of change.files) await runMultica(['skill', 'files', 'upsert', change.id, '--path', path, '--content-stdin'], { ...cli, input: change.localFiles[path] });
    }
    if (change.type === 'project') {
      const p = change.local;
      await runMultica(['project', 'update', change.id, '--title', p.title, '--description', p.description ?? '', '--status', p.status ?? ''], cli);
    }
    console.log(`Applied ${change.type} ${change.name}.`);
  }
  const remaining = await inspectLocal(snapshot, options.profile, { print: false });
  if (remaining.length) {
    for (const change of remaining) console.error(`Verification failed for ${change.type} ${change.name}: ${change.fields.join(', ')}`);
    throw new Error(`post-apply verification found ${remaining.length} resource(s) still different`);
  }
  console.log(`Updated and verified ${changes.length} resource(s).`);
}

export async function syncWorkspace(options) {
  if (options.action === 'pull') return pull(options);
  if (options.action === 'diff') return diff(options);
  if (options.action === 'push') return push(options);
  throw new Error(`unsupported workspace action: ${options.action}`);
}

import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { listItems } from "../multica/client.mjs";
import {
  WORKSPACE_FIELDS,
  PROJECT_RESOURCE_FIELDS,
  formattedJson,
  normalizedProjectResource,
  projectResourceKey,
  pick,
  safeRelativePath,
  slugify,
} from "./format.mjs";
import { fieldsFor, idOf, readJson, write } from "./shared.mjs";

async function walk(root, dir = root) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, item.name);
    if (item.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${path}`);
    if (item.isDirectory()) files.push(...(await walk(root, path)));
    if (item.isFile()) files.push(path);
  }
  return files;
}

async function dirs(parent, marker) {
  const out = [];
  for (const item of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const dir = join(parent, item.name);
    try {
      await stat(join(dir, marker));
      out.push(dir);
    } catch {}
  }
  return out;
}

function validateFields(value, fields, path) {
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`${path} must be a JSON object`);
  for (const key of Object.keys(value))
    if (!fields.includes(key)) throw new Error(`${path} contains unsupported field: ${key}`);
  for (const key of fields)
    if (value[key] === undefined) throw new Error(`${path} is missing required field: ${key}`);
}

async function findLocal(root, identifier) {
  const parent = join(root, "src/workspaces");
  for (const name of await readdir(parent).catch(() => []))
    try {
      const dir = join(parent, name);
      const workspace = await readJson(join(dir, "workspace.json"));
      if ([name, workspace.slug, workspace.id].includes(identifier)) return { dir, workspace };
    } catch {}
  return null;
}

export async function localSnapshot(root, identifier, { required = true } = {}) {
  const found = await findLocal(root, identifier);
  if (!found) {
    if (required) throw new Error(`local workspace snapshot not found for ${identifier}; run workspace pull first`);
    return null;
  }
  const workspacePath = join(found.dir, "workspace.json");
  validateFields(found.workspace, WORKSPACE_FIELDS, workspacePath);
  idOf(found.workspace, workspacePath);
  const items = { workspace: [found.workspace], agent: [], skill: [], project: [] };
  for (const [type, marker] of [["agent", "agent.json"], ["skill", "skill.json"], ["project", "project.json"]])
    for (const dir of await dirs(join(found.dir, `${type}s`), marker)) {
      const path = join(dir, marker);
      const value = await readJson(path);
      validateFields(value, fieldsFor(type), path);
      idOf(value, path);
      if (type === "agent") value.instructions = await readFile(join(dir, "instructions.md"), "utf8");
      if (type === "skill") {
        value.content = await readFile(join(dir, "SKILL.md"), "utf8");
        value.files = {};
        for (const filePath of await walk(dir)) {
          const rel = safeRelativePath(dir, filePath);
          if (["skill.json", "SKILL.md"].includes(rel)) continue;
          value.files[rel] = await readFile(filePath, "utf8");
        }
      }
      if (type === "project") {
        value.resources = await readJson(join(dir, "resources.json")).catch(() => []);
        if (!Array.isArray(value.resources)) throw new Error(`${join(dir, "resources.json")} must be a JSON array`);
        const resourceIds = new Set();
        const newResourceKeys = new Set();
        for (const resource of value.resources) {
          for (const key of Object.keys(resource)) if (!PROJECT_RESOURCE_FIELDS.includes(key)) throw new Error(`${join(dir, "resources.json")} contains unsupported field: ${key}`);
          if (!resource.resource_ref || typeof resource.resource_ref.url !== "string" || !resource.resource_ref.url.trim()) throw new Error(`${join(dir, "resources.json")} resource_ref.url must be a non-empty string`);
          if (resource.id) {
            const resourceId = idOf(resource, join(dir, "resources.json"));
            if (resourceIds.has(resourceId)) throw new Error(`duplicate project resource id: ${resourceId}`);
            resourceIds.add(resourceId);
          } else {
            const key = projectResourceKey(resource);
            if (newResourceKeys.has(key)) throw new Error(`duplicate new project resource: ${key}`);
            newResourceKeys.add(key);
          }
          Object.assign(resource, normalizedProjectResource(resource));
        }
      }
      Object.defineProperty(value, "localDir", { value: dir });
      items[type].push(value);
    }
  for (const [type, values] of Object.entries(items)) {
    const seen = new Set();
    for (const value of values) {
      const key = idOf(value, type);
      if (seen.has(key)) throw new Error(`duplicate ${type} id: ${key}`);
      seen.add(key);
    }
  }
  return { ...found, items };
}

export async function normalizeLocalSlugs(local) {
  const renames = [];
  for (const type of ["agent", "skill", "project"])
    for (const item of local.items[type]) {
      const expectedSlug = slugify(item.name || item.title);
      if (!expectedSlug) throw new Error(`${type} ${item.id} name must produce a non-empty slug`);
      const target = join(dirname(item.localDir), expectedSlug);
      if (target !== item.localDir) renames.push({ type, id: item.id, source: item.localDir, target });
    }
  for (const entry of renames)
    try {
      await stat(entry.target);
      throw new Error(`${entry.type} ${entry.id} slug target already exists: ${entry.target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  for (const entry of renames) await rename(entry.source, entry.target);
  return renames;
}

async function trash(root, workspaceDir, path) {
  const target = join(root, ".multica/trash", new Date().toISOString().replace(/[:.]/g, "-"), relative(workspaceDir, path));
  await mkdir(dirname(target), { recursive: true });
  await rename(path, target);
}

export async function writeLocal(root, remote, hard, local) {
  const dir = join(root, "src/workspaces", remote.slug);
  await write(join(dir, "workspace.json"), formattedJson(pick({ ...remote.workspace, slug: remote.slug }, WORKSPACE_FIELDS)));
  for (const [type, marker] of [["agent", "agent.json"], ["skill", "skill.json"], ["project", "project.json"]])
    for (const item of remote.items[type]) {
      const itemDir = join(dir, `${type}s`, slugify(item.name || item.title));
      await write(join(itemDir, marker), formattedJson(pick(item, fieldsFor(type))));
      if (type === "project") await write(join(itemDir, "resources.json"), formattedJson((item.resources || []).map(normalizedProjectResource)));
      if (type === "agent") await write(join(itemDir, "instructions.md"), String(item.instructions ?? ""));
      if (type === "skill") {
        await write(join(itemDir, "SKILL.md"), String(item.content ?? ""));
        for (const file of item.files || []) {
          if (!file.path || file.path === "SKILL.md") continue;
          const target = resolve(itemDir, file.path);
          if (!target.startsWith(`${resolve(itemDir)}${sep}`)) throw new Error(`unsafe Skill file path: ${file.path}`);
          await write(target, String(file.content ?? ""));
        }
        if (hard) {
          const expectedFiles = new Set(["skill.json", "SKILL.md", ...listItems(item.files).filter((file) => file?.path && file.path !== "SKILL.md").map((file) => file.path)]);
          for (const path of await walk(itemDir)) {
            const rel = safeRelativePath(itemDir, path);
            if (!expectedFiles.has(rel)) await trash(root, dir, path);
          }
        }
      }
    }
  if (hard && local)
    for (const [type, marker] of [["agent", "agent.json"], ["skill", "skill.json"], ["project", "project.json"]])
      for (const itemDir of await dirs(join(dir, `${type}s`), marker)) {
        const value = await readJson(join(itemDir, marker));
        if (!remote.items[type].some((x) => x.id === value.id)) await trash(root, dir, itemDir);
      }
}

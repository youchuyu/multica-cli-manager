import { relative, sep } from 'node:path';

export const AGENT_FIELDS = ['id', 'name', 'description', 'runtime_id', 'model', 'thinking_level', 'permission_mode', 'max_concurrent_tasks'];
export const SKILL_FIELDS = ['id', 'name', 'description'];
export const PROJECT_FIELDS = ['id', 'title', 'description', 'status'];
export const PROJECT_RESOURCE_FIELDS = ['id', 'resource_type', 'resource_ref', 'label'];

export function normalizedProjectResource(value) {
  return {
    ...(value?.id ? { id: value.id } : {}),
    resource_type: value?.resource_type || 'github_repo',
    resource_ref: value?.resource_ref,
    label: value?.label ?? null,
  };
}

export const projectResourceKey = (value) =>
  `${value?.resource_type || 'github_repo'}:${JSON.stringify(value?.resource_ref ?? null)}`;
export const WORKSPACE_FIELDS = ['id', 'name', 'slug'];

export const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function pick(value, fields) {
  return Object.fromEntries(fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

export const normalizeText = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');

export function normalizedResource(value, fields) {
  return Object.fromEntries(fields.map((key) => [key, value?.[key] ?? null]));
}

export function changedFields(local, remote, fields) {
  return fields.filter((key) => JSON.stringify(local?.[key] ?? null) !== JSON.stringify(remote?.[key] ?? null));
}

export const formattedJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function safeRelativePath(root, path) {
  const result = relative(root, path);
  if (!result || result.startsWith(`..${sep}`) || result === '..') throw new Error(`unsafe Skill file path: ${path}`);
  return result.split(sep).join('/');
}

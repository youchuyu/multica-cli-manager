import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';

export const AGENT_FIELDS = [
  'id',
  'name',
  'description',
  'runtime_id',
  'model',
  'thinking_level',
  'service_tier',
  'permission_mode',
  'max_concurrent_tasks',
  'custom_args',
  'runtime_config',
  'mcp_config',
  'skill_ids',
];
export const SKILL_FIELDS = ['id', 'name', 'description'];
export const PROJECT_FIELDS = ['id', 'title', 'description', 'status'];
export const SQUAD_FIELDS = ['id', 'name', 'description', 'avatar_url', 'leader_id'];
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

export const slugify = (name) => String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

export function pick(value, fields) {
  return Object.fromEntries(fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

export const normalizeText = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

export const secretFingerprint = (value) =>
  createHash('sha256').update(JSON.stringify(canonicalJson(value ?? null))).digest('hex');

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

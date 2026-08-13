import yaml from 'js-yaml';

export const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function agentMarkdown(agent) {
  const fields = {
    name: agent.name, description: agent.description ?? '', model: agent.model ?? '',
    permission_mode: agent.permission_mode ?? '', visibility: agent.visibility ?? '',
    max_concurrent_tasks: agent.max_concurrent_tasks ?? 6, runtime_id: agent.runtime_id ?? '',
    thinking_level: agent.thinking_level ?? ''
  };
  return `---\n${yaml.dump(fields, { lineWidth: -1 }).trimEnd()}\n---\n\n# Instructions\n\n${agent.instructions ?? ''}\n`;
}

export function parseAgent(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n\n# Instructions\n\n([\s\S]*)$/);
  if (!match) throw new Error('invalid Agent markdown');
  return { fields: yaml.load(match[1]) ?? {}, instructions: match[2].replace(/\n$/, '') };
}

export const stable = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());

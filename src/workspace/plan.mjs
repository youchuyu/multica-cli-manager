import {
  AGENT_FIELDS,
  PROJECT_FIELDS,
  SQUAD_FIELDS,
  SKILL_FIELDS,
  WORKSPACE_FIELDS,
  changedFields,
  normalizeText,
  normalizedProjectResource,
  pick,
  secretFingerprint,
} from "./format.mjs";

const fieldsFor = (type) =>
  ({
    workspace: WORKSPACE_FIELDS,
    agent: AGENT_FIELDS,
    skill: SKILL_FIELDS,
    project: PROJECT_FIELDS,
    squad: SQUAD_FIELDS,
  })[type];

const fileHash = (content) => normalizeText(content);
const keyOf = (type, item) => `${type}:${item.id}`;

function skillFileMap(files) {
  const output = {};
  for (const file of Array.isArray(files) ? files : files?.items ?? files?.data ?? []) {
    if (!file?.path || file.path === "SKILL.md") continue;
    output[file.path] = { content: fileHash(file.content), id: file.id };
  }
  return output;
}

export function normalized(snapshot) {
  const out = {};
  for (const [type, values] of Object.entries(snapshot.items))
    for (const value of values) {
      const data = pick(value, fieldsFor(type));
      if (type === "agent") {
        data.instructions = fileHash(value.instructions);
        data.custom_env = secretFingerprint(value.custom_env || {});
        data.skill_ids = [...(value.skill_ids || [])].sort();
        data.mcp_config = secretFingerprint(value.mcp_config);
      }
      if (type === "skill") {
        const files = Array.isArray(value.files)
          ? skillFileMap(value.files)
          : value.files || {};
        data.content = fileHash(value.content);
        data.files = Object.fromEntries(
          Object.entries(files).map(([path, file]) => [
            path,
            typeof file === "string" ? fileHash(file) : file.content,
          ]),
        );
      }
      if (type === "project") data.resources = (value.resources || []).map(normalizedProjectResource).map(({ id, ...resource }) => resource);
      if (type === "squad") {
        data.instructions = fileHash(value.instructions);
        data.members = [...(value.members || [])].map(({ member_type, member_id, role }) => ({ member_type, member_id, role })).sort((a, b) => `${a.member_type}:${a.member_id}`.localeCompare(`${b.member_type}:${b.member_id}`));
      }
      out[keyOf(type, value)] = data;
    }
  return out;
}

export function plan(direction, source, target, base, hard) {
  const sourceNorm = normalized(source),
    targetNorm = target ? normalized(target) : {},
    baseNorm = base?.resources || null;
  const operations = [],
    blocked = [];
  for (const [key, value] of Object.entries(sourceNorm)) {
    const [type, id] = key.split(":");
    const current = targetNorm[key];
    const previous = baseNorm?.[key];
    if (!current)
      operations.push({
        action: "create",
        resource_type: type,
        id,
        name: value.name || value.title || value.id,
      });
    else if (JSON.stringify(value) !== JSON.stringify(current)) {
      const fields = changedFields(value, current, Object.keys(value)).filter(
        (x) => x !== "id" && x !== "files" && x !== "resources",
      );
      const conflictingFields = fields.filter((field) => {
        if (!previous) return true;
        const baseline = Object.hasOwn(previous, field) ? previous[field] : current[field];
        return JSON.stringify(value[field] ?? null) !== JSON.stringify(baseline ?? null)
          && JSON.stringify(current[field] ?? null) !== JSON.stringify(baseline ?? null);
      });
      if (!hard && conflictingFields.length)
        blocked.push(
          `${type} ${id} differs from target in ${conflictingFields.join(", ")}; use --hard after review`,
        );
      else {
        if (fields.length)
          operations.push({
            action: "update",
            resource_type: type,
            id,
            name: value.name || value.title || value.id,
            fields,
          });
      }
    } else
      operations.push({
        action: "keep",
        resource_type: type,
        id,
        name: value.name || value.title || value.id,
      });
  }
  for (const project of source.items.project) {
    const targetProject = target?.items.project.find((x) => x.id === project.id);
    if (!targetProject) {
      for (const resource of (project.resources || []).map(normalizedProjectResource))
        operations.push({
          action: "upsert",
          resource_type: "project_resource",
          project_id: project.id,
          resource,
          name: resource.label || resource.resource_ref?.url || resource.resource_type,
        });
      continue;
    }
    const sourceResources = (project.resources || []).map(normalizedProjectResource);
    const targetResources = (targetProject.resources || []).map(normalizedProjectResource);
    const targetById = Object.fromEntries(targetResources.filter((x) => x.id).map((x) => [x.id, x]));
    const sourceIds = new Set(sourceResources.flatMap((x) => x.id ? [x.id] : []));
    for (const resource of sourceResources) {
      const current = resource.id ? targetById[resource.id] : targetResources.find((x) => !sourceIds.has(x.id) && x.resource_type === resource.resource_type && JSON.stringify(x.resource_ref) === JSON.stringify(resource.resource_ref));
      if (!current) operations.push({ action: "upsert", resource_type: "project_resource", project_id: project.id, resource, name: resource.label || resource.resource_ref?.url || resource.resource_type });
      else if (resource.id && JSON.stringify(resource) !== JSON.stringify(current)) operations.push({ action: "update", resource_type: "project_resource", project_id: project.id, id: resource.id, resource });
    }
    for (const resource of targetResources) if (resource.id && !sourceIds.has(resource.id) && !sourceResources.some((x) => !x.id && x.resource_type === resource.resource_type && JSON.stringify(x.resource_ref) === JSON.stringify(resource.resource_ref))) operations.push({ action: "delete", resource_type: "project_resource", project_id: project.id, id: resource.id, resource });
  }
  for (const [key, value] of Object.entries(targetNorm))
    if (!sourceNorm[key]) {
      const [type, id] = key.split(":");
      if (hard)
        operations.push({
          action:
            direction === "push"
              ? type === "agent"
                ? "archive"
                : "delete"
              : "delete-local",
          resource_type: type,
          id,
          name: value.name || value.title || id,
        });
      else {
        operations.push({
          action: direction === "push" ? "remote-only" : "local-only",
          resource_type: type,
          id,
          name: value.name || value.title || id,
        });
        blocked.push(
          `${type} ${id} exists only on target; use --hard to clean it`,
        );
      }
    }
  for (const skill of source.items.skill) {
    const targetSkill = target?.items.skill.find((x) => x.id === skill.id);
    if (!targetSkill) continue;
    const sourceFiles =
      direction === "push"
        ? Object.fromEntries(Object.entries(skill.files || {}).map(([path, content]) => [path, fileHash(content)]))
        : skillFileMap(skill.files);
    const targetFiles =
      direction === "push"
        ? skillFileMap(targetSkill.files)
        : targetSkill.files;
    for (const [path, content] of Object.entries(sourceFiles))
      if (
        !(path in targetFiles) ||
        (typeof targetFiles[path] === "string"
          ? targetFiles[path]
          : targetFiles[path].content) !==
          (typeof content === "string" ? content : content.content)
      )
        operations.push({
          action: "upsert",
          resource_type: "skill_file",
          skill_id: skill.id,
          path,
        });
    for (const [path, file] of Object.entries(targetFiles))
      if (!(path in sourceFiles)) {
        if (hard)
          operations.push({
            action: direction === "push" ? "delete" : "delete-local",
            resource_type: "skill_file",
            skill_id: skill.id,
            file_id: file.id,
            path,
          });
        else {
          operations.push({
            action: direction === "push" ? "remote-only" : "local-only",
            resource_type: "skill_file",
            skill_id: skill.id,
            file_id: file.id,
            path,
          });
          blocked.push(
            `skill file ${path} exists only on target; use --hard to clean it`,
          );
        }
      }
  }
  for (const squad of source.items.squad || []) {
    const targetSquad = target?.items.squad?.find((x) => x.id === squad.id);
    const sourceMembers = (squad.members || []).map(({ member_type, member_id, role }) => ({ member_type, member_id, role }));
    if (!targetSquad) {
      for (const member of sourceMembers) {
        const isLeader = member.member_type === "agent" && member.member_id === squad.leader_id;
        operations.push({ action: isLeader ? "set-role" : "add", resource_type: "squad_member", squad_id: squad.id, member, name: `${squad.name}/${member.role}` });
      }
      continue;
    }
    const targetMembers = (targetSquad.members || []).map(({ member_type, member_id, role }) => ({ member_type, member_id, role }));
    const targetByKey = new Map(targetMembers.map((m) => [`${m.member_type}:${m.member_id}`, m]));
    const sourceKeys = new Set(sourceMembers.map((m) => `${m.member_type}:${m.member_id}`));
    for (const member of sourceMembers) {
      const key = `${member.member_type}:${member.member_id}`;
      if (!targetByKey.has(key)) operations.push({ action: "add", resource_type: "squad_member", squad_id: squad.id, member, name: `${squad.name}/${member.role}` });
      else if (member.role !== targetByKey.get(key).role) operations.push({ action: "set-role", resource_type: "squad_member", squad_id: squad.id, member, name: `${squad.name}/${member.role}` });
    }
    for (const member of targetMembers) if (!sourceKeys.has(`${member.member_type}:${member.member_id}`)) {
      if (hard) operations.push({ action: "remove", resource_type: "squad_member", squad_id: squad.id, member, name: `${squad.name}/${member.role}` });
      else blocked.push(`squad member ${squad.id}/${member.member_id} exists only on target; use --hard to clean it`);
    }
  }
  return {
    workspace_id: source.workspace.id,
    direction,
    hard,
    operations,
    blocked,
  };
}

export function display(plan, output) {
  if (output === "json") console.log(JSON.stringify(plan, null, 2));
  else
    for (const op of plan.operations)
      console.log(
        `${op.action.toUpperCase()} ${op.resource_type} ${op.name || op.path || op.id}${op.fields?.length ? ` (${op.fields.join(", ")})` : ""}`,
      );
}

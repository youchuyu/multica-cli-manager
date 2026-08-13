import {
  AGENT_FIELDS,
  PROJECT_FIELDS,
  SKILL_FIELDS,
  WORKSPACE_FIELDS,
  changedFields,
  normalizeText,
  pick,
} from "./format.mjs";

const fieldsFor = (type) =>
  ({
    workspace: WORKSPACE_FIELDS,
    agent: AGENT_FIELDS,
    skill: SKILL_FIELDS,
    project: PROJECT_FIELDS,
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
      if (type === "agent") data.instructions = fileHash(value.instructions);
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
      const sourceChanged =
          !previous || JSON.stringify(value) !== JSON.stringify(previous),
        targetChanged =
          !previous || JSON.stringify(current) !== JSON.stringify(previous);
      if (!hard && targetChanged && (sourceChanged || !baseNorm))
        blocked.push(
          `${type} ${id} differs from target; use --hard after review`,
        );
      else {
        const fields = changedFields(value, current, Object.keys(value)).filter(
          (x) => x !== "id" && x !== "files",
        );
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
      direction === "push" ? skill.files : skillFileMap(skill.files);
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

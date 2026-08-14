import { listItems, runMultica } from "../multica/client.mjs";
import { join } from "node:path";
import { slugify } from "./format.mjs";
import { fieldsFor, idOf, write } from "./shared.mjs";
import { formattedJson, pick } from "./format.mjs";

function validateRemoteProjectResources(projectId, resources) {
  const seen = new Set();
  for (const resource of resources) {
    const id = idOf(resource, `remote Project ${projectId} resource`);
    if (seen.has(id)) throw new Error(`duplicate remote project resource id: ${id}`);
    seen.add(id);
    if (resource.project_id && resource.project_id !== projectId)
      throw new Error(`remote Project resource ${id} project_id does not match ${projectId}`);
  }
  return resources;
}

async function remoteSkill(id, cli) {
  const [skill, files] = await Promise.all([
    runMultica(["skill", "get", id], cli),
    runMultica(["skill", "files", "list", id], cli),
  ]);
  return { ...skill, files: listItems(files) };
}

export async function remoteSnapshot(identifier, profile) {
  if (!identifier) throw new Error("workspace <slug|id> is required");
  const workspace = await runMultica(["workspace", "get", identifier], {
    profile,
  });
  idOf(workspace, "remote workspace");
  const resolved = {
    workspace,
    id: workspace.id,
    slug: workspace.slug || slugify(workspace.name),
  };
  const cli = { profile, workspaceId: resolved.id };
  const [agents, skills, projects] = await Promise.all([
    runMultica(["agent", "list"], cli),
    runMultica(["skill", "list"], cli),
    runMultica(["project", "list"], cli),
  ]);
  const fullAgents = await Promise.all(
    listItems(agents).map((x) =>
      runMultica(["agent", "get", idOf(x, "remote Agent")], cli),
    ),
  );
  const fullSkills = await Promise.all(
    listItems(skills).map((x) => remoteSkill(idOf(x, "remote Skill"), cli)),
  );
  const fullProjects = await Promise.all(
    listItems(projects).map((x) =>
      (async () => {
        const id = idOf(x, "remote Project");
        const [project, resources] = await Promise.all([
          runMultica(["project", "get", id], cli),
          runMultica(["project", "resource", "list", id], cli),
        ]);
        return { ...project, resources: validateRemoteProjectResources(id, listItems(resources)) };
      })(),
    ),
  );
  return {
    ...resolved,
    cli,
    items: {
      workspace: [resolved.workspace],
      agent: fullAgents,
      skill: fullSkills,
      project: fullProjects,
    },
  };
}

const localById = (local, type, id) =>
  local.items[type].find((x) => x.id === id);

async function persistCreatedItem(item, type, created) {
  item.id = idOf(created, `created ${type}`);
  const marker = type === "agent" ? "agent.json" : type === "skill" ? "skill.json" : "project.json";
  await write(join(item.localDir, marker), formattedJson(pick(item, fieldsFor(type))));
}

async function persistProjectResources(project) {
  await write(
    join(project.localDir, "resources.json"),
    formattedJson(project.resources.map((resource) => ({
      ...(resource.id ? { id: resource.id } : {}),
      resource_type: resource.resource_type,
      resource_ref: resource.resource_ref,
      label: resource.label ?? null,
    }))),
  );
}

export async function applyPush(syncPlan, local, remote) {
  const cli = remote.cli;
  let destructiveFailure = false;
  const projectIds = new Map();
  const execute = async (op) => {
    if (destructiveFailure && ["delete", "archive"].includes(op.action))
      return { ...op, result: "skipped_after_failure" };
    try {
      if (op.resource_type === "agent" && op.action === "create") {
        const item = localById(local, "agent", op.id);
        const created = await runMultica([
          "agent", "create", "--name", item.name, "--runtime-id", item.runtime_id,
          "--description", item.description, "--instructions", item.instructions,
          "--model", item.model, "--thinking-level", item.thinking_level,
          "--permission-mode", item.permission_mode,
          "--max-concurrent-tasks", String(item.max_concurrent_tasks),
        ], cli);
        await persistCreatedItem(item, "agent", created);
      }
      if (op.resource_type === "skill" && op.action === "create") {
        const item = localById(local, "skill", op.id);
        const created = await runMultica([
          "skill", "create", "--name", item.name, "--description", item.description,
          "--content-stdin",
        ], { ...cli, input: item.content });
        await persistCreatedItem(item, "skill", created);
        for (const [path, content] of Object.entries(item.files))
          await runMultica(["skill", "files", "upsert", item.id, "--path", path, "--content-stdin"], { ...cli, input: content });
      }
      if (op.resource_type === "project" && op.action === "create") {
        const item = localById(local, "project", op.id);
        const created = await runMultica([
          "project", "create", "--title", item.title, "--description", item.description,
          "--status", item.status,
        ], cli);
        projectIds.set(op.id, idOf(created, "created project"));
        await persistCreatedItem(item, "project", created);
      }
      if (op.resource_type === "agent" && op.action === "update") {
        const item = localById(local, "agent", op.id);
        const args = ["agent", "update", op.id];
        const flags = {
          name: "--name", description: "--description", runtime_id: "--runtime-id",
          model: "--model", thinking_level: "--thinking-level",
          permission_mode: "--permission-mode", max_concurrent_tasks: "--max-concurrent-tasks",
        };
        for (const field of op.fields)
          if (field === "instructions") args.push("--instructions", item.instructions);
          else if (flags[field]) args.push(flags[field], String(item[field] ?? ""));
        await runMultica(args, cli);
      }
      if (op.resource_type === "skill" && op.action === "update") {
        const item = localById(local, "skill", op.id);
        const args = ["skill", "update", op.id];
        for (const field of op.fields.filter((x) => ["name", "description"].includes(x)))
          args.push(`--${field}`, String(item[field] ?? ""));
        const content = op.fields.includes("content") ? item.content : undefined;
        if (content !== undefined) args.push("--content-stdin");
        await runMultica(args, { ...cli, input: content });
      }
      if (op.resource_type === "project" && op.action === "update") {
        const item = localById(local, "project", op.id);
        const args = ["project", "update", op.id];
        for (const field of op.fields)
          if (["title", "description", "status"].includes(field))
            args.push(`--${field}`, String(item[field] ?? ""));
        await runMultica(args, cli);
      }
      if (op.resource_type === "project_resource") {
        const r = op.resource;
        const projectId = projectIds.get(op.project_id) || op.project_id;
        if (op.action === "upsert") {
          const created = await runMultica(["project", "resource", "add", projectId, "--type", r.resource_type || "github_repo", "--ref", JSON.stringify(r.resource_ref), ...(r.label ? ["--label", r.label] : [])], cli);
          const previousId = r.id;
          r.id = idOf(created, "created project resource");
          const project = local.items.project.find((item) => item.id === projectId);
          if (project) {
            const localResource = project.resources.find((resource) =>
              (previousId && resource.id === previousId) ||
              (!previousId && resource.resource_type === r.resource_type && JSON.stringify(resource.resource_ref) === JSON.stringify(r.resource_ref)),
            );
            if (!localResource) throw new Error(`local Project resource was not found after creation: ${projectId}`);
            localResource.id = r.id;
            await persistProjectResources(project);
          }
        }
        if (op.action === "update") await runMultica(["project", "resource", "update", projectId, op.id, "--ref", JSON.stringify(r.resource_ref), ...(r.label ? ["--label", r.label] : ["--clear-label"])], cli);
        if (op.action === "delete") await runMultica(["project", "resource", "remove", projectId, op.id], { ...cli, json: false });
      }
      if (op.resource_type === "skill_file" && op.action === "upsert") {
        const item = localById(local, "skill", op.skill_id);
        await runMultica(["skill", "files", "upsert", op.skill_id, "--path", op.path, "--content-stdin"], { ...cli, input: item.files[op.path] });
      }
      if (op.resource_type === "skill_file" && op.action === "delete")
        await runMultica(["skill", "files", "delete", op.skill_id, op.file_id], { ...cli, json: false });
      if (op.resource_type === "agent" && op.action === "archive")
        await runMultica(["agent", "archive", op.id], cli);
      if (op.resource_type === "skill" && op.action === "delete")
        await runMultica(["skill", "delete", op.id, "--yes"], { ...cli, json: false });
      if (op.resource_type === "project" && op.action === "delete")
        await runMultica(["project", "delete", op.id], cli);
      return { ...op, result: "succeeded" };
    } catch (error) {
      if (["delete", "archive"].includes(op.action)) destructiveFailure = true;
      return { ...op, result: "failed", error: error.message };
    }
  };
  const priority = (op) => {
    if (op.action === "create") return 0;
    if (op.action === "update" || op.action === "upsert") return 1;
    if (op.resource_type === "skill_file" && op.action === "delete") return 2;
    if (op.resource_type === "agent" && op.action === "archive") return 3;
    if (op.resource_type === "project" && op.action === "delete") return 4;
    if (op.resource_type === "skill" && op.action === "delete") return 5;
    return 6;
  };
  const results = [];
  for (const op of syncPlan.operations
    .filter((x) => !["keep", "remote-only", "local-only"].includes(x.action))
    .sort((a, b) => priority(a) - priority(b)))
    results.push(await execute(op));
  const failed = results.filter((x) => x.result === "failed");
  if (failed.length)
    throw new Error(`execution partially failed: ${failed.map((x) => `${x.resource_type} ${x.id || x.path}: ${x.error}`).join("; ")}`);
  return results;
}

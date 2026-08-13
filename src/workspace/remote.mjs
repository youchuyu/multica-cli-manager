import { listItems, runMultica } from "../multica/client.mjs";
import { slugify } from "./format.mjs";
import { idOf } from "./shared.mjs";

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

export async function applyPush(syncPlan, local, remote) {
  const cli = remote.cli;
  let destructiveFailure = false;
  const execute = async (op) => {
    if (destructiveFailure && ["delete", "archive"].includes(op.action))
      return { ...op, result: "skipped_after_failure" };
    try {
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
        if (op.action === "upsert") await runMultica(["project", "resource", "add", op.project_id, "--type", r.resource_type || "github_repo", "--ref", JSON.stringify(r.resource_ref), ...(r.label ? ["--label", r.label] : [])], cli);
        if (op.action === "update") await runMultica(["project", "resource", "update", op.project_id, op.id, "--ref", JSON.stringify(r.resource_ref), ...(r.label ? ["--label", r.label] : ["--clear-label"])], cli);
        if (op.action === "delete") await runMultica(["project", "resource", "remove", op.project_id, op.id], { ...cli, json: false });
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
    if (op.action === "update" || op.action === "upsert") return 0;
    if (op.resource_type === "skill_file" && op.action === "delete") return 1;
    if (op.resource_type === "agent" && op.action === "archive") return 2;
    if (op.resource_type === "project" && op.action === "delete") return 3;
    if (op.resource_type === "skill" && op.action === "delete") return 4;
    return 5;
  };
  const results = [];
  for (const op of syncPlan.operations
    .filter((x) => !["keep", "remote-only", "local-only", "create"].includes(x.action))
    .sort((a, b) => priority(a) - priority(b)))
    results.push(await execute(op));
  const failed = results.filter((x) => x.result === "failed");
  if (failed.length)
    throw new Error(`execution partially failed: ${failed.map((x) => `${x.resource_type} ${x.id || x.path}: ${x.error}`).join("; ")}`);
  return results;
}

import { join } from "node:path";
import { formattedJson } from "../workspace/format.mjs";
import { localSnapshot, writeLocal } from "../workspace/local.mjs";
import { display, normalized, plan } from "../workspace/plan.mjs";
import { applyPush, remoteSnapshot } from "../workspace/remote.mjs";
import { readJson, write } from "../workspace/shared.mjs";

async function readBase(root, id) {
  try {
    return await readJson(join(root, ".multica/states", `${id}.json`));
  } catch {
    return null;
  }
}

async function writeBase(root, id, state) {
  await write(
    join(root, ".multica/states", `${id}.json`),
    formattedJson({ version: 2, resources: state }),
  );
}

export async function syncWorkspace(options) {
  const {
    root,
    action,
    workspace: identifier,
    profile,
    hard = false,
    dryRun = false,
    output = "text",
  } = options;
  if (!["pull", "push", "diff"].includes(action))
    throw new Error(`unsupported workspace action: ${action}`);
  if (action === "diff") {
    const local = await localSnapshot(root, identifier);
    const remote = await remoteSnapshot(identifier, profile);
    return display(
      plan("push", local, remote, await readBase(root, remote.id), false),
      output,
    );
  }
  const remote = await remoteSnapshot(identifier, profile);
  const local = await localSnapshot(root, identifier, {
    required: action === "push",
  });
  if (local && local.workspace.id !== remote.id)
    throw new Error("workspace.json id does not match resolved remote Workspace");
  const source = action === "pull" ? remote : local;
  const target = action === "pull" ? local : remote;
  const syncPlan = plan(
    action,
    source,
    target,
    await readBase(root, remote.id),
    hard,
  );
  display(syncPlan, output);
  if (syncPlan.blocked.length) {
    const error = new Error(syncPlan.blocked.join("\n"));
    error.code = "CONFLICT";
    throw error;
  }
  if (dryRun) return;
  if (action === "pull") await writeLocal(root, remote, hard, local);
  else await applyPush(syncPlan, local, remote);
  const verifyRemote = await remoteSnapshot(remote.id, profile);
  const verifyLocal = await localSnapshot(root, remote.id, { required: false });
  const expected = action === "pull" ? normalized(verifyRemote) : normalized(local);
  const actual = action === "pull" ? normalized(verifyLocal) : normalized(verifyRemote);
  for (const [key, value] of Object.entries(expected))
    if (JSON.stringify(value) !== JSON.stringify(actual[key]))
      throw new Error(`post-apply verification failed for ${key}`);
  if (hard && Object.keys(actual).some((key) => !expected[key]))
    throw new Error("post-apply verification found target-only resources");
  await writeBase(root, remote.id, normalized(verifyRemote));
  console.log(`${action} completed and verified.`);
}

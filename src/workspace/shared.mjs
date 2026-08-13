import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AGENT_FIELDS,
  PROJECT_FIELDS,
  SKILL_FIELDS,
  WORKSPACE_FIELDS,
} from "./format.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export async function write(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

export function idOf(value, path) {
  if (!UUID.test(value?.id ?? ""))
    throw new Error(`${path} must contain a valid remote id`);
  return value.id;
}

export const fieldsFor = (type) =>
  ({
    workspace: WORKSPACE_FIELDS,
    agent: AGENT_FIELDS,
    skill: SKILL_FIELDS,
    project: PROJECT_FIELDS,
  })[type];

# Workspace 操作指南

## 项目用途

本项目用于版本化管理 Multica Workspace 的 Agent、Skill、Project 和 Squad 声明。远端操作由 `multica-cli-manager` 通过原生 `multica` CLI 完成。

## 目录结构

- `src/workspaces/<slug>/workspace.json`：Workspace 信息。
- `agents/`：Agent 配置、`instructions.md` 和精确同步但默认不提交的 `custom-env.json`。
- `skills/`：Skill 配置、`SKILL.md` 和附属文件。
- `projects/`：Project 配置。
- `squads/`：Squad 配置、`instructions.md` 和 `members.json`。

## 操作要求

- 首次使用前执行 `multica setup`。
- 修改声明后先执行 `npm run workspace:diff -- <slug-or-id>`。
- push 前先执行 `npm run workspace:push -- <slug-or-id> --dry-run`。
- 未经明确确认不要使用 `--hard`。
- 不要修改资源 UUID 或增加不支持的 JSON 字段。
- 不要提交 `custom-env.json`、凭据、`.env`、`.multica/states/` 或 `.multica/trash/`。

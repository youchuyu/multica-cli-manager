# multica-cli-manager

创建空白的 Multica workspace 版本化项目，并通过原生 `multica` CLI pull、diff、push 已存在的远端资源。

```sh
npx multica-cli-manager my-multica-project
cd my-multica-project
npm install
multica setup

npm run workspace:pull -- --workspace <slug-or-id>
npm run workspace:diff -- --workspace <slug-or-id>
npm run workspace:push -- --workspace <slug-or-id>
npm run workspace:push -- --workspace <slug-or-id> --apply
```

首次 pull 会生成：

```text
src/workspaces/<workspace-slug>/
├── workspace.json
├── agents/<agent-slug>/
│   ├── agent.json
│   └── instructions.md
├── skills/<skill-slug>/
│   ├── skill.json
│   ├── SKILL.md
│   └── <附属文件>
└── projects/<project-slug>/project.json
```

JSON 字段直接映射 Multica CLI 的 `snake_case` 数据。v1 只维护核心字段；不会保存凭据、运行态、统计字段、Agent-Skill assignment 或 Project resources。

`push` 默认只预览。只有显式添加 `--apply` 才会更新远端，并在更新后重新读取验证。本版本不创建、删除、归档或恢复资源，也不会删除远端 Skill 附属文件。认证信息由 Multica CLI profile 管理，可通过 `--profile <name>` 选择。

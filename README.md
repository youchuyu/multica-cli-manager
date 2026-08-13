# multica-cli-manager

创建空白的 Multica workspace 版本化项目，并通过原生 `multica` CLI pull、diff、push 已存在的远端资源。

```sh
npx multica-cli-manager my-multica-project
cd my-multica-project
npm install
multica setup

npm run workspace:pull -- <slug-or-id>
npm run workspace:diff -- <slug-or-id>
npm run workspace:push -- <slug-or-id>
npm run workspace:push -- <slug-or-id> --dry-run
```

生成的项目根目录包含 `README.md`、`AGENTS.md`、`package.json` 和 `.gitignore`；Workspace 声明初始为空，首次 pull 后写入 `src/workspaces/`。

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

JSON 字段直接映射 Multica CLI 的 `snake_case` 数据。只维护核心字段；不会保存凭据、运行态、统计字段、Agent-Skill assignment 或 Project resources。

`pull` 和 `push` 默认完成完整检查、执行和复读验证；`--dry-run` 只输出计划、保证零写入。默认模式遇到冲突或目标端额外资源会阻断；`--hard` 以同步源为权威并清理目标端额外内容。hard pull 将本地额外目录或文件移至 `.multica/trash/`；hard push 归档额外 Agent，并删除额外 Skill、Project 和 Skill 附属文件。`--hard` 仍不会绕过结构、身份、范围或路径检查。

当前仅更新已有远端资源；本版本不创建资源。认证信息由 Multica CLI profile 管理，可通过 `--profile <name>` 选择。`.multica/states/` 保存不含凭据的同步基线，默认不进入 Git。

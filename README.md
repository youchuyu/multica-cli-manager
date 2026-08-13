# multica-cli-manager

通过 `npx` 创建一个空白的 Multica workspace 版本化管理项目，再用 pull/diff/push 同步远端 workspace。

```sh
npx multica-cli-manager my-multica-project
cd my-multica-project
npm install

multica setup
npm run workspace:pull -- --workspace <slug-or-id>
npm run workspace:diff -- --workspace <slug-or-id>
npm run workspace:push -- --workspace <slug-or-id> --apply
```

新项目中的 `src/workspace/` 初始为空。首次 pull 会创建：

```text
src/workspace/<workspace-slug>/
├── workspace.yaml
├── resources.json
├── agents/*.md
├── skills/*/SKILL.md
└── projects/*/project.yaml
```

`diff` 只读比较本地和远端。`push` 默认 dry-run；只有显式添加 `--apply` 才会更新由 `resources.json` 跟踪的 Agent、Skill 和 Project。本版本不删除远端资源，也不保存 Multica token；使用 `--profile <name>` 可选择命名 profile。

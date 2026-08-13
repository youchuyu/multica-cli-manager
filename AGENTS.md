# 仓库指南

## 项目定位

当前项目是一个生成脚手架的工具，而不是脚手架本身。它负责生成可版本化的 Multica Workspace 项目，并提供同步能力的实现。生成项目中的目录、npm scripts 和使用说明由 `src/commands/create-project.mjs` 产出，不应作为当前仓库自身的操作约定。

本工具构建在原生 `multica` CLI 之上：本项目负责脚手架生成、同步编排、冲突检查和写后验证；`multica` 负责认证、Server 通信及远端资源读写。原生命令和参数以 `multica --help` 为准，不要另行实现 API 或认证客户端。

## 源码结构

- `bin/multica-cli-manager.mjs`：工具的 CLI 入口和参数解析。
- `src/commands/create-project.mjs`：生成脚手架项目。
- `src/commands/workspace-sync.mjs`：同步流程编排。
- `src/multica/`：原生 `multica` CLI 适配。
- `src/workspace/`：快照、差异计划、校验和写入。
- `templates/`：生成项目的 `README.md`、`AGENTS.md` 和 `gitignore` 模板。
- `test/`：生成器和同步逻辑测试。
- `docs/`：当前工具的设计文档。

## 开发与验证

```sh
npm install
npm test
node bin/multica-cli-manager.mjs --help
```

项目无需编译。提交前运行 `npm test` 和 `git diff --check`。

使用 JavaScript ESM、`.mjs` 文件、两空格缩进和分号。变量使用 `camelCase`，文件名使用 kebab-case；Multica 数据字段保留 `snake_case`。

修改生成内容时，优先更新 `templates/` 并同步调整对应测试；动态结构仍由 `create-project.mjs` 生成。修改同步逻辑时，必须覆盖写入前校验、预览模式零写入、执行顺序和写后复读验证。测试使用临时目录和假 `multica` CLI，不得依赖真实凭据或远端环境，也不得绕过 UUID、Workspace 范围、Schema 和路径安全校验。

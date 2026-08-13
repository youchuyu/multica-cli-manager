# Multica Server、CLI、守护进程与本地智能体执行链路

本文基于当前仓库源码，说明 Multica 如何把一个任务调度到用户电脑上的本地智能体 CLI，以及代码在哪里修改、仓库如何落盘、提示词和依赖安装分别由谁负责。

本文中的「任务」指产品层的 `issue`；`task` 指某一次具体执行。两者不是同一个概念：一个任务可以触发多次 `task` 执行。

## 1. 先给结论

```text
Web / multica CLI
        │ HTTP API
        ▼
Multica Server
        │ 创建或唤醒 task
        ▼
本机 Multica daemon
        │ 准备执行目录、仓库和运行时配置
        ▼
Claude / Codex / Cursor 等外部 Agent CLI
        │ 在本地 workdir 中读取、编辑、测试代码
        ▼
daemon 回传消息、日志、状态和 usage
        ▼
Server 持久化，Web 通过 Realtime/API 展示
```

职责边界如下：

| 部件 | 主要职责 | 是否直接修改业务代码 |
| --- | --- | --- |
| Web / CLI | 提交任务、更新任务、展示结果 | 否 |
| Server | 权限、任务队列、claim、重试、业务状态 | 否 |
| daemon | 领取任务、准备本地环境、启动进程、回传结果 | 通常否 |
| Agent Backend | 适配 Provider 的启动参数和输出协议 | 否 |
| Claude / Codex / Cursor CLI | 使用模型和工具完成任务 | 是 |

daemon 负责「在哪里、以什么环境运行」；外部 Agent CLI 负责「如何分析和修改代码」。

## 2. `server/` 中的程序边界

`server/` 是一个 Go 工程，包含多个二进制入口：

```text
server/cmd/server/       → Multica Server 服务端进程
server/cmd/multica/      → multica CLI，同时包含 daemon 子命令
server/cmd/migrate/      → 数据库迁移工具
server/cmd/backfill_*/   → 运维和数据回填工具
```

同一个 `multica` 二进制可以进入不同模式：

```bash
multica issue list       # 短生命周期 CLI 命令，调用 Server API 后退出
multica --help           # 查看本地命令帮助
multica daemon start     # 启动常驻 daemon
```

CLI 是调用 Server API 的客户端；daemon 是 `multica daemon start` 进入的常驻运行时角色；Server 是服务端进程；Claude、Codex、Cursor 等则是 daemon 启动的外部 Agent CLI。

## 3. Server、daemon 与外部 Agent

daemon 通常通过 daemon WebSocket 与 Server 保持连接，并配合 HTTP fallback、轮询和断线重连：

```text
daemon ⇄ Server daemon WebSocket
```

一次执行大致经过：

```text
用户提交或分配任务
        ↓
Server 写入任务队列并唤醒 Runtime
        ↓
daemon 获取本地执行槽位并 claim task
        ↓
准备 workdir、仓库、Skill、MCP 和环境变量
        ↓
按 provider 启动外部 Agent CLI
        ↓
流式回传输出和进度
        ↓
完成、失败、取消或重试
```

daemon 会先取得本地并发槽位，再向 Server 领取任务，避免 Server 已派发任务但本机没有执行容量。不同 Provider 的适配代码位于 `server/pkg/agent/`。

## 4. 代码修改到底在哪里发生

代码修改发生在 Agent CLI 的当前工作目录，即本次执行的本地 `workdir` 中。真正执行文件编辑、补丁应用、格式化、测试和构建的是 Claude/Codex/Cursor 等外部进程，不是提示词，也不是 Server。

典型目录结构如下：

```text
<WorkspacesRoot>/
├── .repos/<workspace-id>/           # daemon 管理的 bare Git cache
└── <workspace-id>/<task-short-id>/
    ├── workdir/                     # Agent 的执行根目录
    │   └── <repo-name>/             # checkout 后的可编辑源码目录
    ├── output/                      # 任务输出
    ├── logs/                        # 运行日志
    └── codex-home/                  # Codex 等运行时文件
```

当前 `Prepare` 会先创建空的任务 `workdir`，仓库由 Agent 按需执行：

```bash
multica repo checkout <repo-url>
```

checkout 成功后，源码通常位于 `.../<task-short-id>/workdir/<repo-name>/`。daemon 会把相应目录作为外部 Agent 的 `cwd`；Agent 的补丁、编辑器写文件、shell 命令和测试都会作用于这个目录。

## 5. bare Git cache 与任务 worktree

对于远程 Git 仓库，daemon 在本机维护一份 Git bare cache，初始化方式类似：

```bash
git clone --bare <repo-url> <cache-path>
```

bare 仓库只有 Git 对象和引用，没有展开的源码文件：

```text
project.git/
├── HEAD
├── config
├── objects/
├── refs/
└── packed-refs
```

缓存根目录是 `<WorkspacesRoot>/.repos/<workspace-id>/<repo-dir>`。bare cache 只用于保存和复用 Git 数据，Agent 不应直接在其中编辑代码。

任务 checkout 时，daemon 对 bare cache 执行 fetch，再创建任务专属 worktree：

```text
远程 Git 仓库
      ↓ git clone --bare / git fetch
本机 .repos bare cache
      ↓ git worktree add -b agent/...
任务 workdir/<repo-name>
      ↓
Agent CLI 修改代码
```

多个任务可以共享 Git 对象，但每个任务拥有独立源码目录和任务分支。创建 worktree 不会自动 commit、push 或创建 PR。

实现位置：

- `server/internal/daemon/repocache/cache.go`：bare cache、fetch 和 worktree；
- `server/internal/daemon/execenv/execenv.go`：任务执行目录；
- `server/internal/daemon/daemon.go`：任务准备和 Agent 启动。

如果要求“启动 Agent 前保证仓库已在本地”，应把 `multica repo checkout` 从提示词约定提升为 daemon 准备阶段的强制动作：checkout 失败就不启动 Agent。这属于 daemon 代码改造，单纯修改提示词只能要求 Agent 遵守。

## 6. daemon 提供哪些提示词

daemon 给 Agent 的上下文是两层内容。

### 6.1 每轮动态 prompt

`server/internal/daemon/prompt.go` 的 `BuildPrompt` 根据任务类型生成本轮 prompt：

- 普通 assignment：任务 ID、`Ownership` 模式、handoff note，以及读取任务和评论的命令；
- 评论触发：`Reply` 模式、触发评论正文、作者、线程和回复 `--parent`；
- Chat：用户消息、受众形态、Slack/其他 IM 的历史读取和附件规则；
- Quick-create：将用户输入转换为一次 `multica issue create`；
- Autopilot run-only：自动化 ID、触发 payload 和自动化说明。

本轮 prompt 还可能追加 session 恢复失败提示、发起人信息和连接的应用信息。

### 6.2 runtime brief

daemon 会把完整运行说明写入 Agent 原生读取的上下文文件：

```text
Claude       → CLAUDE.md
Codex 等     → AGENTS.md
Qwen         → QWEN.md
CodeBuddy    → CODEBUDDY.md
```

runtime brief 通常包含 Agent 身份、instructions、Multica CLI 使用边界、任务工作流、评论/回复/mention/附件规则、Skills、项目仓库上下文、MCP 配置以及后台进程和结果交付约束。部分 Provider 不会自动读取工作目录中的上下文文件，daemon 会将 runtime brief 作为 `SystemPrompt` 内联传递。

提示词只描述任务和约束；它不负责执行文件复制、安装依赖或修改源码。

## 7. 依赖安装与静态代码分析

当前 worktree/cache 流程默认只准备源码和 Git 元数据，不在通用任务准备阶段统一执行依赖安装：

```bash
pnpm install --frozen-lockfile
npm install
go mod download
python -m venv ...
```

因此任务开始时可能存在 `package.json` 和 lockfile，但没有 `node_modules`。Agent 可以根据项目规则自行安装依赖并执行检查：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
go mod download
go test ./...
go vet ./...
```

静态代码分析不是做不到，而是当前默认不由 daemon 强制保证。若依赖未安装，依赖工具驱动的检查可能失败。

如果产品要求每次代码修复都必须完成依赖准备和静态检查，应实现为：

```text
checkout
  → 安装/恢复依赖
  → 修改前基线检查
  → Agent 修改代码
  → 修改后静态检查和测试
  → 汇报检查结果
```

这类检查需要纳入超时、日志、失败分类和多仓库策略。当前 GC 会关注并清理 `node_modules`、`.next` 和 `.turbo` 等任务产物，依赖目录不应默认视为永久缓存。

## 8. 本机路径和桌面端影响

默认 `WorkspacesRoot` 是 `~/multica_workspaces`，当前电脑上的默认绝对路径为：

```text
/Users/youchuyu/multica_workspaces
```

任务目录计算规则是：

```text
/Users/youchuyu/multica_workspaces/<workspace-id>/<task-short-id>/workdir
```

本机已看到类似目录：

```text
/Users/youchuyu/multica_workspaces/b6fdf434-965b-43b0-a479-0836f86fdc40/664a5a51/workdir
/Users/youchuyu/multica_workspaces/b6fdf434-965b-43b0-a479-0836f86fdc40/664a5a51/workdir/ainvest-etf
```

当前电脑同时存在两个 daemon 实例：

```text
/usr/local/bin/multica daemon start --foreground --server-url http://mulapi.myhexin.com
/Applications/Multica.app/.../multica daemon start --foreground --profile desktop-api.multica.ai
```

第二个由 Multica Desktop 启动。它们可以连接不同 Server/profile，也可能使用不同的 `WorkspacesRoot`。命名 profile 的默认目录规则是 `~/multica_workspaces_<profile>`，但 `MULTICA_WORKSPACES_ROOT` 或显式配置可以覆盖默认值。因此判断某次任务的实际目录时，应以 daemon 的 profile/config 和任务日志为准。

## 9. Agent Provider 的启动边界

daemon 不实现模型推理，而是通过 `server/pkg/agent/` 中的 Provider Backend 启动本机 CLI：

```text
provider=claude → claude
provider=codex  → codex
provider=cursor → cursor-agent
```

Backend 把统一的 `ExecOptions` 转换成具体 CLI 参数，并解析 stdout/stderr、stream-json 或 ACP 协议。典型参数包括：

```text
Cwd              → 任务 workdir
Model            → 指定模型
Timeout          → 本次执行超时
ResumeSessionID  → 可恢复的历史会话
ExtraArgs        → Runtime 默认参数
CustomArgs       → Agent 自定义参数
MCP 配置          → 任务级工具服务配置
```

daemon 还负责取消和清理进程组，避免 Agent 退出后留下 MCP Server 或其他工具子进程。

## 10. 结果、提交和远程仓库

Agent 修改完代码后，daemon 负责收集执行结果并向 Server 报告。代码是否 commit、push 或创建 PR，取决于任务指令、Agent instructions、Skill 和 Agent 实际执行的命令。

可能出现的结果包括：

- 只留下任务 worktree 中的未提交修改；
- Agent 执行 `git commit`，在任务分支形成提交；
- Agent 执行 `git push`，将分支推送到远程；
- Agent 创建 PR 后在任务评论中汇报；
- 修改或检查失败，由 daemon 将失败原因回传 Server。

“Agent 已完成代码修改”和“远程仓库已经出现可合并提交”是两条不同的事实，不能混为一谈。

## 11. 最终架构判断

```text
Server
  └─ 业务状态、权限、任务队列、重试和审计

multica CLI
  └─ 命令行 API 客户端

multica daemon
  └─ Runtime 注册、claim、并发、workdir、仓库准备、进程管理和回传

Agent Backend
  └─ Claude/Codex/Cursor 等 CLI 的参数和协议适配

外部 Agent CLI
  └─ 模型交互、工具调用、源码编辑、依赖安装、静态分析和测试

bare Git cache
  └─ 本机 Git 对象复用，不是 Agent 的编辑目录

任务 worktree
  └─ 本次 Agent 实际读取和修改代码的目录
```

最关键的边界是：

> 提示词描述任务和约束；daemon 准备本地执行环境并启动进程；外部 Agent CLI 在任务 workdir 中完成代码修改。当前 daemon 默认不统一安装依赖，也不强制执行静态分析；如果需要这些保证，应把它们实现为 daemon 的代码级生命周期步骤，而不是只依赖提示词。

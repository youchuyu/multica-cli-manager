# multica-cli-manager 设计文档

## 1. 文档范围

本文描述 `multica-cli-manager` 当前代码的设计与实现边界。项目是原生 `multica` CLI 之上的薄管理层，用于：

1. 生成一个空白、可版本化的 Multica Workspace 声明项目；
2. 将已有远端 Workspace 的 Agent、Skill 和 Project 拉取为本地文件；
3. 比较本地声明与远端资源；
4. 在显式命令下把本地变更同步回远端，并在写入后复读验证。

它不实现 Multica Server、认证、任务调度或 Agent 执行，也不取代原生 `multica` CLI。远端连接和凭据继续由 CLI profile 管理。

## 2. 设计目标与非目标

### 2.1 设计目标

- **可版本化**：将核心配置保存为 JSON、Markdown 和普通文件，适合 Git 审查。
- **薄封装**：所有远端读写都调用原生 `multica` 命令，不复制服务端 SDK 或认证逻辑。
- **默认安全**：同步前完整读取两端并生成计划；冲突、目标端额外资源和身份不匹配默认阻断。
- **可预览**：`--dry-run` 输出完整计划，不调用任何修改类命令。
- **可验证**：实际 pull/push 后重新读取本地和远端，比较规范化状态。
- **最小声明**：只保存受支持的核心字段，排除凭据、运行态、统计数据和未纳入同步范围的关联关系。
- **路径安全**：拒绝符号链接、越界路径、非法远端 ID 和结构外字段。

### 2.2 非目标

- 不创建缺失的远端 Agent、Skill 或 Project；计划中的 `create` 仅表示差异，本版本不会执行创建。
- 不同步 Agent-Skill assignment、Project resources、运行状态或统计字段。
- 不保存或分发认证信息。
- 不提供服务端、多 Workspace 事务或跨机器锁。
- 不保证部分远端写入失败后的自动回滚。
- 不管理 Multica daemon 或外部 Agent CLI 的执行生命周期。

## 3. 系统上下文

```text
用户 / npm scripts
        │
        ▼
bin/multica-cli-manager.mjs
        │
        ├── createProject() ──► 生成空白声明项目
        │
        └── syncWorkspace()
                │
                ├── 本地文件系统
                │     ├── src/workspaces/
                │     ├── .multica/states/
                │     └── .multica/trash/
                │
                └── MulticaClient ──spawn──► 原生 multica CLI ──► Multica Server
```

本项目只负责声明项目和同步控制。`multica` CLI 是命令及参数语义的权威来源；Server 是远端资源的最终持有者。

## 4. 代码结构与职责

```text
multica-cli-manager/
├── bin/
│   └── multica-cli-manager.mjs       # CLI 入口、参数解析、退出码
├── src/
│   ├── commands/
│   │   ├── create-project.mjs        # 空项目脚手架
│   │   └── workspace-sync.mjs        # pull/diff/push 编排
│   ├── multica/
│   │   └── client.mjs                # 原生 multica 子进程适配
│   └── workspace/
│       ├── format.mjs                # 字段白名单、文本及路径规范化
│       ├── local.mjs                 # 本地快照读取、校验、写入和回收站
│       ├── plan.mjs                  # 状态规范化、三方比较、操作计划
│       ├── remote.mjs                # 远端快照读取和 push 操作执行
│       └── shared.mjs                # JSON/文件 IO、UUID 和字段映射
├── test/core.test.mjs                # 假 CLI 驱动的核心行为测试
└── docs/
```

分层原则如下：

- `bin` 只负责把命令行输入转换为 command 参数，不承载同步规则；
- `commands` 负责用例编排；
- `workspace` 负责领域模型、差异计划和本地/远端适配；
- `multica/client.mjs` 只负责可靠启动原生 CLI、传递 stdin 和解析 JSON。

## 5. 命令设计

### 5.1 创建声明项目

```sh
npx multica-cli-manager <project-name>
```

行为：

1. 要求目标路径不存在，避免覆盖已有目录；
2. 规范化 npm package 名称；
3. 创建空的 `src/workspaces/`；
4. 生成 `package.json`、`.gitignore` 和使用说明；
5. 将本包作为开发依赖，并提供 pull/diff/push npm scripts。

生成项目刻意不携带示例 Workspace。首次 pull 后才出现真实声明，避免示例资源被误认为待同步配置。

### 5.2 Workspace 命令

```sh
multica-cli-manager workspace pull <slug|id> [--profile <name>] [--dry-run] [--hard]
multica-cli-manager workspace diff <slug|id> [--profile <name>]
multica-cli-manager workspace push <slug|id> [--profile <name>] [--dry-run] [--hard]
```

- Workspace 使用位置参数；`--workspace` 暂时兼容旧调用方式。
- 同时提供两种写法时，两者必须一致。
- `--profile` 原样传给原生 CLI。
- `--output json` 是代码支持的计划输出形式，当前帮助文本未公开列出。
- 冲突退出码为 `2`，其他错误退出码为 `1`。

`diff` 以 push 方向展示本地相对远端的计划，不执行写入，也不更新同步基线。

## 6. 本地声明模型

首次 pull 后目录结构如下：

```text
src/workspaces/<workspace-slug>/
├── workspace.json
├── agents/<agent-slug>/
│   ├── agent.json
│   └── instructions.md
├── skills/<skill-slug>/
│   ├── skill.json
│   ├── SKILL.md
│   └── <Skill 附属文件>
└── projects/<project-slug>/
    └── project.json
```

目录名用于可读性和定位，资源身份以 JSON 中的远端 UUID 为准。所有 JSON 字段沿用原生 CLI 的 `snake_case`。

| 资源 | 版本化字段/内容 |
| --- | --- |
| Workspace | `id`, `name`, `slug` |
| Agent | `id`, `name`, `description`, `runtime_id`, `model`, `thinking_level`, `permission_mode`, `max_concurrent_tasks`, `instructions.md` |
| Skill | `id`, `name`, `description`, `SKILL.md`, 全部附属文本文件 |
| Project | `id`, `title`, `description`, `status` |

本地解析采用严格模式：声明必须包含该资源的全部受支持字段，也不能出现白名单之外的字段。这能防止“看似已版本化、实际上不会同步”的配置进入仓库。

当前 Skill 文件按 UTF-8 文本处理；二进制附件不在设计范围内。

## 7. 快照与规范化

同步比较的输入不是原始文件或 CLI 响应，而是统一的快照：

```js
{
  workspace,
  id,
  slug,
  items: {
    workspace: [],
    agent: [],
    skill: [],
    project: []
  }
}
```

### 7.1 本地快照

`localSnapshot()`：

- 通过目录名、Workspace slug 或 UUID 定位本地 Workspace；
- 校验 JSON 结构和 UUID；
- 读取 Agent instructions、Skill 主内容及递归附属文件；
- 拒绝符号链接；
- 检测同类型重复 ID。

### 7.2 远端快照

`remoteSnapshot()`：

1. 执行 `multica workspace get` 解析 Workspace；
2. 并行列出 Agent、Skill、Project；
3. 逐项读取完整资源；
4. 对每个 Skill 同时读取元数据和文件列表；
5. 返回附带 profile 和 Workspace ID 的 CLI 上下文。

### 7.3 比较规范化

`normalized()` 将每个资源映射为 `<type>:<uuid>`，只保留受支持字段。文本统一换行并忽略末尾多余换行，因此 JSON 排版和文本尾部换行不会制造无意义差异。

## 8. 同步基线与冲突模型

成功同步后，远端规范化快照写入：

```text
.multica/states/<workspace-id>.json
```

该文件是三方比较的基线，不含凭据，默认被生成项目的 `.gitignore` 排除。比较包含：

```text
source：本次同步方向的权威端
target：将被修改的一端
base：上一次成功同步并验证后的远端状态
```

默认模式下，只要 source 与 target 对同一资源存在差异，且不能证明目标端未发生竞争修改，就会阻断并要求人工审查。第一次同步没有基线，因此对已有差异采取保守策略。

目标端独有资源也会阻断：

- pull 时是本地独有资源；
- push 时是远端独有资源。

`--hard` 将本次 source 视为权威端，允许覆盖冲突并清理目标端独有内容，但仍不绕过结构、UUID、Workspace 身份和路径校验。

## 9. pull 流程

```text
解析远端 Workspace
  → 读取远端完整快照
  → 读取可选本地快照
  → 校验 Workspace ID
  → 生成 pull 计划
  → 输出计划
  → 冲突检查
  → dry-run 则结束
  → 写入本地声明
  → 复读远端与本地
  → 规范化比较
  → 写入同步基线
```

普通 pull 更新远端已存在的资源，但不会静默移除本地独有内容。hard pull 会把本地独有资源目录、Skill 附属文件移动到：

```text
.multica/trash/<timestamp>/<workspace-relative-path>
```

采用移动到回收站而非直接删除，使本地清理保持可恢复。

## 10. push 流程

```text
读取远端完整快照
  → 读取并严格校验本地快照
  → 校验 Workspace ID
  → 生成 push 计划
  → 输出计划
  → 冲突检查
  → dry-run 则结束
  → 按安全顺序执行操作
  → 复读远端与本地
  → 规范化比较
  → 写入同步基线
```

执行顺序为：

1. 资源字段更新和 Skill 文件 upsert；
2. Skill 文件删除；
3. Agent archive；
4. Project 删除；
5. Skill 删除。

这样可以优先完成非破坏性更新，把删除类操作放在后面。若删除或归档失败，后续删除/归档会跳过，降低连续破坏的范围。任一执行失败都会以“部分失败”结束，并且不会写入新的同步基线。

hard push 对远端独有资源的处理是：

- Agent：archive；
- Skill：delete；
- Project：delete；
- Skill 附属文件：delete。

远端删除通常不可由本工具自动恢复，因此 `--hard` 应先配合 `--dry-run` 审查计划。

## 11. 计划操作语义

| 操作 | 含义 | 当前是否执行 |
| --- | --- | --- |
| `keep` | 两端一致 | 无需执行 |
| `update` | 更新资源字段或主内容 | push 执行 |
| `upsert` | 新增或更新 Skill 附属文件 | push 执行 |
| `create` | source 存在、target 不存在 | push 时创建 Agent、Skill 或 Project，并回写远端 ID |
| `local-only` / `remote-only` | target 独有，默认阻断 | 不执行 |
| `delete-local` | hard pull 清理本地独有内容 | pull 移入回收站 |
| `archive` | hard push 归档远端 Agent | push 执行 |
| `delete` | hard push 删除远端资源或文件 | push 执行 |

push 会创建远端不存在的 Agent、Skill 和 Project，并将原生 CLI 返回的真实 ID 回写到本地快照。新建 Project 的附属资源会在 Project 创建后添加；Skill 的附属文件会在 Skill 创建后 upsert。创建前的本地 UUID 仅用于本地计划关联，成功后不再保留。

## 12. 原生 CLI 适配

`runMultica()` 使用 `spawn('multica', args)`，避免 shell 插值。它统一处理：

- `--profile`；
- `--workspace-id`；
- 默认 `--output json`；
- 通过 stdin 传递 Skill 内容，避免把大段正文放入命令参数；
- 非零退出码和无效 JSON。

远端能力依赖原生 CLI 的实际命令契约。升级 `multica` 后，应以 `multica --help` 和子命令帮助为准复核调用参数，并运行本项目测试。

## 13. 安全设计

### 13.1 身份与范围

- 所有声明资源必须携带合法 UUID；
- 本地 `workspace.json.id` 必须等于远端解析结果；
- 所有资源操作都显式携带 Workspace ID；
- 本地目录名不能替代远端身份。

### 13.2 文件系统

- 创建项目不覆盖已存在目标；
- 本地快照拒绝符号链接；
- Skill 文件写入前验证解析后的路径仍位于 Skill 目录内；
- hard pull 使用项目内回收站；
- 状态和回收站默认不提交 Git。

### 13.3 远端写入

- `diff` 和 `--dry-run` 零写入；
- 默认冲突和额外资源阻断；
- 更新按字段生成参数，避免覆盖未变字段；
- 写入后复读验证；
- 删除失败后停止后续破坏性操作。

### 13.4 凭据

本地声明、基线和日志设计上均不需要凭据。认证由 `multica setup` 创建的 profile 管理。本项目不应把 token、环境密钥或 profile 内容写入 Workspace 文件。

## 14. 一致性与失败语义

同步不是跨本地文件系统和远端 Server 的原子事务：

- pull 可能在写完部分文件后因 IO 或复读失败而结束；
- push 可能在部分远端操作成功后失败；
- 计划生成与执行之间，其他客户端仍可能修改远端；
- 多个进程同时同步同一 Workspace 时没有本地锁。

当前缓解手段是保守冲突检查、顺序执行、破坏性失败熔断和完成后的全量复读。失败时不会更新基线，操作者应重新运行 `diff` 或 `--dry-run`，以实际两端状态重新生成计划，不能假定失败等于零变更。

## 15. 测试策略

核心测试使用临时目录和一个假的 `multica` 可执行文件，覆盖：

- 空项目脚手架；
- 字段白名单与文本规范化；
- pull 的最小字段输出和嵌套 Skill 文件；
- push dry-run 零修改；
- 字段级更新、Skill 文件 upsert 和写后验证；
- 非法远端 ID 在写入前被拒绝。

运行方式：

```sh
npm test
```

这些测试证明本项目编排逻辑，不证明真实 profile、远端权限或某个版本原生 CLI 的线上可用性。发布前还应增加真实 CLI 的受控集成验证。

## 16. 当前限制与演进方向

按优先级建议：

1. **明确处理 create**：要么实现受控创建和真实 ID 回填，要么在计划阶段直接阻断 `create`，避免执行到验证阶段才失败。
2. **增加操作前再校验**：在首个远端写入前复核基线或版本标识，缩小计划与执行之间的竞争窗口。
3. **完善失败报告**：以结构化 JSON 输出每个操作的 succeeded、failed、skipped 状态，方便人工修复。
4. **增加进程锁**：避免同一项目、同一 Workspace 被多个本地进程同时同步。
5. **增强集成测试**：针对真实 `multica --help` 契约、archive/delete 行为和 hard pull 回收站补充覆盖。
6. **版本化声明格式**：若字段范围继续扩大，应为本地 schema 增加显式版本和迁移机制。
7. **二进制 Skill 文件策略**：明确拒绝、Base64 表示或独立二进制传输机制。

## 17. 关键设计结论

`multica-cli-manager` 的核心不是再实现一套 Multica 客户端，而是建立一个安全、可审查的声明同步边界：

```text
本地普通文件
  → 严格解析与最小字段模型
  → 本地/远端/基线三方比较
  → 可审查操作计划
  → 原生 multica CLI 执行
  → 两端复读验证
```

因此，原生 CLI 负责远端协议和认证，本项目负责版本化表达、差异判断、安全策略与验收闭环。任何新增能力都应继续遵守这条边界，避免在管理器内部形成第二套服务端模型或认证实现。

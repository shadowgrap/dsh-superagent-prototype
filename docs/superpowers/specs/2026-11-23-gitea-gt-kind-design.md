# Gitea Source kind（基于 gt CLI）设计

- 日期：2026-11-23（v2：Gitea-only 部署 + 完整公民范围）
- 分支：`kind/gitea-gt`（fork 自 `main`）
- 状态：待评审

## 1. 意图

新增与 `github`、`feishu` 并列的 **`gitea` Source kind**，只通过 Gitea 官方 CLI `gt`（gitea-cli ≥ 2.0）与实例交互；并让 Gitea **可以单独使用**（不需要任何 GitHub 账号），且 Gitea 工单是**完整公民**（PR 在面板可见、执行器可读、PR 结束会通知、评估器可读仓库文件）。

动机是**可维护性**：`forgejo-17` 分支用自维护的 REST 封装（约 580 行）适配 Gitea，个人维护的封装会随上游漂移；官方 CLI 的字段契约由上游承担。

## 2. 目标

1. `gitea` kind 的行为与 `github` kind 一一对应：通知唤醒 → 逐条拉详情 → 仓库事件流观察 → 已订阅线程轮询 → 触发进入准入闸门 → 在原始会话回话。
2. **Gitea-only**：只配置 Gitea 就能起完整功能，GitHub 不安装、不配置也不阻塞。
3. **完整公民**：Gitea 工单的 PR 出现在 `ticketCard`、可被 `claimPull`、`orchestrator_report` 可读、PR 结束有通知、评估器可读仓库文件、worker 有 `gitea/` 资源与 `gitea` 技能。
4. 两个仓库来源可以同时启用。
5. 复用现有的轮次模型、游标、重试、健康报告，不新造调度。

## 3. 非目标

- **Forgejo**：`gt` 不支持 Forgejo，本 kind 只服务 Gitea ≥ 28。`forgejo-17` 分支与本文无关。
- **自动合并**：`main` 的 `github` kind 不含合并闸门，本 kind 保持同等能力（`gt pr merge --match-head-commit` 留作后续）。
- **标记已读**：不调用 `gt notification mark-read`。`ponytail: 不标已读，收件箱会一直显示未读；日后要清理再加`。
- **worker 的 `gh` 兼容壳**：gitea worker 用 `gt`，不伪装成 `gh`。

## 4. 约束（真实例实测，Gitea 28.4.0 / gt 2.0.0）

| 事实 | 影响 |
|---|---|
| `GITEA_CLI_CONFIG_DIR` 完全隔离 config/hosts/credentials | 每 profile 一份，不碰操作员环境 |
| 未登录 exit **4** + `{"error":{"code":4,"kind":"authentication"}}` | 错误映射可靠 |
| `--credential-store` 默认 keyring | 必须显式 `file` |
| `gt auth setup-git` 写 `helper = !GITEA_CLI_CONFIG_DIR=… gt auth git-credential --host …`；隔离 `GIT_CONFIG_GLOBAL` 下 `git credential fill` 实测返回账号+token | push 凭据可接；该 helper 是半隐藏接口 |
| `--json` 必须显式列字段 | 所有调用写字段清单 |
| 通知端点是仓库级 `/repos/{o}/{r}/notifications`（`limit/page/status-types/since`） | 无需再按仓库过滤 |
| 同线程新活动刷新同一条通知的 `updated_at`（id 不变），行内评审评论同样刷新 | `--since` 能拉到增量；行内评论靠通知，不需要仓库级流 |
| 通知 `--status` 默认 `[unread,pinned]` | 必须写 `unread,read,pinned` |
| 列表端点**无 ETag**（`/archive`、`/raw` 除外） | 放弃条件轮询 |
| `/notifications` 有 `Link`；issues/comments 只有 `X-Total-Count` | 用「条数 == limit」判断翻页 |
| `gt issue list` `--state` 默认 `open`，支持 `--since`/`--kind`，结果**按 updated_at 降序** | 必须 `--state all`；游标取 max(updated_at) |
| **不存在** `/pulls/comments` 与 `/pulls/{n}/comments`；行内评论在 `/pulls/{n}/reviews/{id}/comments` | 不能照搬 GitHub 路径 |
| `gt pr checks` 合并 Actions 与 commit status；**exit 1 = 有失败、8 = 有待定、0 = 通过** | CI 单一来源 |
| **exit 1 的歧义用流区分**：CI 失败 → stdout 有 JSON、stderr 空；命令失败 → stdout 空、stderr 有 JSON；未知 flag → exit 2 | 无需解析错误文本 |
| `gt run list -b <branch>`、`gt repo view --json actions_enabled,default_branch` | 默认分支 CI 与 `unavailable` 判定可保留 |
| `--include` 把响应头打到 stderr | 仅在需要头时使用 |
| `gt pr review comments/reply/resolve` 存在 | 行内讨论可读可回 |
| `gt schema <cmd>` 输出字段清单与类型 | 字段漂移用测试守住 |
| 冷启动 79ms，`gt notification list` 206ms | 每轮数进程，可接受 |

## 5. 方案

| 方案 | 内容 | 取舍 |
|---|---|---|
| A. `gt api` 透传 | 复用 `github*.ts`，只换 HTTP 层 | 仍需自写 Gitea→GitHub 形状 normalizer，与动机冲突 |
| B. 全原生子命令 | 全部走 `gt` 子命令 | 仓库级 issue 评论流无原生命令，做不到 100% |
| **C. 原生优先，`gt api` 兜底（选中）** | 通知/issue/PR/行内评审/检查/运行/写入走原生；仅「仓库级 issue 评论流」与「raw 文件」用 `gt api` | 官方契约覆盖绝大部分，回落面小 |

**核心改造（由 Q1/Q2 决定）**：本次不只是「加一个 kind」，而是把「仓库来源」从「GitHub 独有」变成**多实现**：

- D1. `Deployment.github` 由必选变可选，新增可选 `gitea`；`deployment.repository` 随之下沉到各自槽位。
- D2. `Setup` 从「一个全局 problem 暂停整个 runtime」改为**每来源一个 problem**，各来源等自己的 `ready`。
- D3. 票面路径按 `source` 分派：`pullOf/pullsOf`、`claimPull`、`pullEndNotices`、`orchestrator_report`、评估器读文件、`github/` 资源、`skill/github`。
- D4. worker 环境按实际存在的来源生成 shim 与 git 凭据。

## 6. 设计

### 6.1 模块

| 文件 | 职责 |
|---|---|
| `src/infra/gt.ts` | `Gt` 传输：cli 路径、`GITEA_CLI_CONFIG_DIR`、`--host`/`-R`/`--no-input`/`GITEA_CLI_ERROR_FORMAT=json`、超时 90s、错误 JSON → `CliError`（code 取 `status`），并提供 `checks()` 区分「CI 失败」与「命令失败」 |
| `src/sources/gitea.ts` | kind 描述符、配置 schema、轮次循环（与 `github.ts` 同构） |
| `src/sources/gitea-trigger.ts` | 线程/触发 ID、地址、`mentions`、人机判定 |
| `src/sources/gitea-read.ts` | PR/Issue/评论/检查/文件读取与事实投影 |
| `src/sources/gitea-pull.ts` | PR 观察、工单绑定、结束通知 |
| `src/sources/gitea-channel.ts` | 回复发送（幂等 marker）、链接 |
| `skills/dsh-superagent-gitea/SKILL.md` | 教 worker 用 `gt` |

### 6.2 部署与配置

```ts
interface Deployment extends Machine {
  github?: { cli: string; login: string; noreply: string; repository: string }
  gitea?:  { cli: string; login: string; noreply: string; baseUrl: string; configDir: string; repository: string; version: string }
  feishu?: FeishuBot
}
```

（main 上 `GithubAccountsSchema` 只有 `repository` 和 `cli`；下文的 gitea 字段显式定义，不沿用「同名同义」的说法。）

```ts
const GiteaConfigSchema = z.object({
  baseUrl, credentialFile, commitEmail, repository, cli,       // 显式定义，见下
  pollSeconds: 60..3600 default 60, failuresBeforeError: 1..20 default 3,
  observeIssues, observePulls, observeComments, observeCi: boolean default false,
}).strict()
```

- `credentialFile`：绝对路径，里面只有 fiume_bot 这类账号的 token。**setup 用它跑一次** `gt auth login --host … --with-token <file> --credential-store file`（`gt api user` 已可用则跳过）。token 不进设置、不进环境变量。
- `commitEmail`：可空；空时取 `gt api user` 的 email，仍非法则 setup 报错要求填写。
- `cli`：`gt` 的绝对路径或命令名（本机实测 gt 不在 PATH 时用绝对路径）。

`resolveDeploymentGitea`：`gt version`（≥ 2.0）→ `gt api version`（实例 ≥ 28）→ 登录态 → 仓库可读且 `permissions.push` → `default_branch`/`actions_enabled`。

### 6.3 Gitea-only 与双来源

- `Setup` 为每个来源维护 `problems: Partial<Record<SourceId, SetupProblem>>`；**没有任何来源配置成功时**才把 runtime 标为未就绪，单个来源失败只影响它自己。
- `SourceRegistry` 的「无存储即 enabled」默认值需要显式处理：**gitea kind 未配置时视为关闭**，setup 不探测（评审指出的坑）。
- `writeEnvironment` 按存在的来源生成：`gt` shim（带 `GITEA_CLI_CONFIG_DIR`）、`gh` shim（有 github 时才写）、git credential 两条、blocked 命令提示改成不带账号名的通用说法。
- 启动自检：`git credential fill`（host = 实例域名）必须返回账号与密码，否则 `SetupError`，提示 `gt auth setup-git`。

### 6.4 轮次（与 github kind 同构，只换命令）

| 通道 | github 现状 | gitea |
|---|---|---|
| 通知 | `notifications?all=true&since=` + 仓库过滤 + ETag | `gt notification list --since=<cursor> --status unread,read,pinned --limit 100 --json=id,number,type,state,unread,updated_at,title`；仓库级端点，去掉过滤 |
| 通知详情 | issue/PR 正文 + 三路评论 | `gt issue view`/`gt pr view` + `gt api repos/{o}/{r}/issues/<n>/comments?since=` + `gt pr review comments <n>` + `gt pr review list <n>` |
| 仓库事件流 | issues / issues-comments / review-comments | `gt issue list --kind all --state all --since=<cursor> --limit 100` + `gt api repos/{o}/{r}/issues/comments?since=`；**行内评论无仓库级流**，靠通知与线程轮询 |
| 已订阅线程 | 逐个 PR 拉检查 | `gt pr view` + `gt pr checks` |
| 默认分支 CI | default_branch → commit → checks/statuses 合流 | `gt repo view --json default_branch,actions_enabled` + `gt run list -b <branch> --json=branch,commit,status,conclusion` |
| 失败重试 | `KV.github.retries` 24h 窗口 | 同构，键为 `KV.gitea.*` |

游标与去重沿用：轮末原子提交 `cursorAt(round.started)`（-5s 重叠），Trigger ID 幂等；游标取本页 `max(updated_at)`，与降序无关。

### 6.5 完整公民：按来源分派

在 `SourceKind` 上增加一个**可选能力**（两个实现，不是抽象工厂）：

```ts
interface RepositorySource {
  /** `<source>:<number>` 线程 ↔ PR 号 */
  pullNumber(thread: string): number | undefined
  readPull(ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull>
  claimPull(ctx: SourceContext, ticketId: string, pull: Pull): string | undefined
  endNotices(ctx: SourceContext, pulls: Pull[]): Promise<void>
  /** 评估器与 worker 读仓库文件 */
  readPath(ctx: SourceContext, path: string, signal?: AbortSignal): Promise<string>
}
interface SourceKind { repository?: RepositorySource }
```

改造点（全部改为按 `source` 取 kind 上的 `repository`）：

| 位置 | 现状 | 改法 |
|---|---|---|
| `src/sources/github-pull.ts` `pullOf/pullsOf` | 只认 `github:` | 从 `SourceRegistry` 取对应 kind 的 `repository` |
| `src/app/cards.ts` `ticketCard` | 用 `pullOf` | 同上，PR 摘要按来源渲染 |
| `src/app/tools/executor.ts` `orchestrator_report` | 直接 `host.github` | 按工单的 `source` 取 |
| `src/sources/github-pull.ts` `pullEndNotices` + `src/app/runtime.ts` | 写死 github.com URL、只跳 github 频道 | 由 `repository.endNotices` 提供 |
| `src/app/assessment.ts` `readRepositoryPath` | 只见 github | 由 `repository.readPath` 提供 |
| `src/app/resources.ts` | 只注册 `github/` | 按存在的来源注册 `gitea/` |
| `src/app/prompts.ts` `skill/github` 与 CLI 说明 | 常驻 | 按来源启用，`gt` 的用法写进 `skill/gitea` |
| `src/app/sessions.ts` 内置技能白名单 | `feishu|github` | 加 `gitea` |

### 6.6 写入

| 目标 | 命令 |
|---|---|
| Issue/PR 会话评论 | `gt issue comment <n> -F -` / `gt pr comment <n> -F -` |
| 行内线程回复 | `gt pr review reply <pr> <comment-id> -F -` |
| 幂等 | 保留 `<!-- dsh-superagent:<message id> -->` marker，发送前查最近的评论 |

### 6.7 读资源与面板

- `gitea/` 读资源走 `gt api repos/{o}/{r}/raw/<path>`（可选：记住 ETag 用 `If-None-Match`，这是 Gitea 唯一支持条件请求的地方）。
- 面板新增 `source.gitea`、`health.gitea`、工单链接图标、设置卡片。
- 环境变量：`DSH_SUPERAGENT_GITEA_URL`、`DSH_SUPERAGENT_GITEA_REPOSITORY`、`DSH_SUPERAGENT_GITEA_ACCOUNT`。

### 6.8 KV

`KV.github` 的五个键（`since`、`retries`、`stream(id)`、`cursor(n)`、`branchCi`）在 `KV.gitea` 下镜像；不动 github 的键。

## 7. 待验证与风险（写进启用须知）

1. **429/限流**：测试实例未开限流。设计用失败指数退避（30s → 2× → 上限 15min），须知里说明「空转约 3 请求/轮，开启限流的实例请把 `pollSeconds` 调到 ≥ 60」。
2. **`gt auth git-credential` 未列入 `gt auth --help`**：2.x 可能改名；启动自检兜底。
3. **Windows 路径转义**：helper 行里是 `!GITEA_CLI_CONFIG_DIR=C:\\… gt.exe auth git-credential`，worker 配置照抄该格式。
4. **字段漂移**：用 `gt schema` 生成断言测试。
5. **版本门槛**：`gt` ≥ 2.0、实例 ≥ Gitea 28，不满足即该来源报错（不阻塞其它来源）。

## 8. 测试

- 单元：触发映射、地址、marker 幂等、检查状态 → CI 事实、通知同 id 刷新的增量处理、exit 1 两种含义的区分。
- schema 守卫：读 `gt schema` 断言消费的字段存在。
- 核心改造的回归：`github` kind 单独配置、`gitea` kind 单独配置、两者同时配置，三种部署都能起、ticketCard 都能显示 PR。
- live（可选）：`tests/gitea-live.spec.ts`，环境变量指向私有测试仓库，覆盖通知→触发、评论写入、行内回复、`pr checks` 退出码、`run list`。

## 9. 工作量

不是「加一个 kind」，是「把仓库来源做成多实现 + 加第二个实现」。粗估按三块：Gitea kind 本体（约 `github*.ts` 同规模，900 行上下）、核心来源化改造（`deployment`/`setup`/`runtime`/`environment`/票面 6 处 + 资源与提示词）、测试与文档。第二块是本设计里唯一会动到既有 GitHub 行为的改动，回归面最大。

## 10. 留给 builder 的开放项

- Gitea 实例 `user.type` 为空时如何判定人机。
- 「评审结论」（approve / request changes）作为独立触发还是并入评论文本。
- 默认分支 CI 是否与通知共用 `pollSeconds`（建议共用）。
- `gitea/` 读资源的 ETag 缓存是否进入本次范围（建议否）。

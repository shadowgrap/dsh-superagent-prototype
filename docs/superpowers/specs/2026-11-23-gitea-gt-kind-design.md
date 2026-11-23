# Gitea Source kind（基于 gt CLI）设计

- 日期：2026-11-23（v3：吸收 tea 版 fork 的实测经验）
- 分支：`kind/gitea-gt`（fork 自 `main`）
- 状态：待评审

## 1. 意图

新增与 `github`、`feishu` 并列的 **`gitea` Source kind**，只通过 Gitea 官方 CLI `gt`（gitea-cli ≥ 2.0）与实例交互；Gitea **可以单独使用**（不需要任何 GitHub 账号），且 Gitea 工单是**完整公民**。

动机是可维护性：手写的 REST 封装会随上游漂移，官方 CLI 的字段契约由上游承担。同类平台优先用官方客户端，不自己维护传输层。

## 2. 目标

1. `gitea` kind 的行为与 `github` kind 一一对应：通知唤醒 → 逐条拉详情 → 仓库事件流观察 → 已订阅线程轮询 → 触发进入准入闸门 → 在原始会话回话。
2. **Gitea-only**：只配置 Gitea 就能起完整功能，GitHub 不安装、不配置也不阻塞。
3. **完整公民**：Gitea 工单的 PR 出现在 `ticketCard`、可被 `claimPull`、`orchestrator_report` 可读、PR 结束有通知、评估器可读仓库文件、worker 有 `gitea/` 资源与 `gitea` 技能。
4. 两个仓库来源可以同时启用。
5. 复用现有的轮次模型、游标、重试、健康报告。

## 3. 非目标

- **自动合并**：`main` 的 `github` kind 不含合并闸门，本 kind 保持同等能力（`gt pr merge --match-head-commit` 留作后续）。
- **标记已读**：不调用 `gt notification mark-read`。`ponytail: 不标已读，收件箱会一直显示未读；日后要清理再加`。
- **worker 的 `gh` 兼容壳**：gitea worker 用 `gt`，不伪装成 `gh`。
- **webhook 唤醒与多实例**：见 §10 开放项，不在本次范围。

## 4. 约束（Gitea 28.4.0 / gt 2.0.0 实测）

| 事实 | 影响 |
|---|---|
| `GITEA_CLI_CONFIG_DIR` 完全隔离 config/hosts/credentials | 每 profile 一份，不碰操作员环境 |
| 未登录 exit **4** + `{"error":{"code":4,"kind":"authentication"}}` | 错误映射可靠 |
| `--credential-store` 默认 keyring | 必须显式 `file` |
| `gt auth setup-git` 写 `helper = !GITEA_CLI_CONFIG_DIR=… gt auth git-credential --host …`；隔离 `GIT_CONFIG_GLOBAL` 下 `git credential fill` 实测返回账号+token | push 凭据可接；该 helper 是半隐藏接口 |
| `--json` 必须显式列字段 | 所有调用写字段清单 |
| 通知端点是仓库级 `/repos/{o}/{r}/notifications`（`limit/page/status-types/since`） | 无需再按仓库过滤 |
| 同线程新活动刷新同一条通知的 `updated_at`（id 不变），行内评论同样刷新；**通知的 `updated_at` 等于事件发生时间** | `--since` 能拉到增量 |
| 通知 `--status` 默认 `[unread,pinned]` | 必须写 `unread,read,pinned` |
| 列表端点**无 ETag**（`/archive`、`/raw` 除外） | 放弃条件轮询 |
| `/notifications` 有 `Link`；issues/comments 只有 `X-Total-Count` | 见 §6.4 分页规则 |
| 实例 `GET /api/v1/settings/api` → **`max_response_items: 50`** | 每页最多 50，`gt api` 路径必须遵守 |
| `gt issue list` `--state` 默认 `open`，支持 `--since`/`--kind`，**按 updated_at 降序** | 必须 `--state all`；游标取 max(updated_at) |
| **不存在** `/pulls/comments` 与 `/pulls/{n}/comments`；行内评论在 `/pulls/{n}/reviews/{id}/comments` | 不能照搬 GitHub 路径 |
| 行内评论**没有父指针**：把 `comments/<id>/replies` 发出去后，列表仍是扁平，无 parent 字段；线程根 = 同一文件同一行的最早一条 | 回复前必须自己算根 |
| raw API 的行内评论 `line` 常为 `null`，而 `gt pr review comments` 给出真实 `line` | 根匹配用 gt 字段，不用 raw JSON |
| 行内评论 `html_url` 是 `/pulls/<n>#issuecomment-<id>`（不是 files 页） | 链接按此渲染 |
| `gt pr checks` 合并 Actions 与 commit status；**exit 1 = 有失败、8 = 有待定、0 = 通过** | CI 单一来源 |
| **exit 1 的歧义用流区分**：CI 失败 → stdout 有 JSON、stderr 空；命令失败 → stdout 空、stderr 有 JSON；未知 flag → exit 2 | 无需解析错误文本 |
| 检查状态接受 `warning`（实测写入后原样返回） | 未知状态「不失败、不通过」 |
| `gt pr review list --json` 提供 `submitted_at`，**没有** `created_at`/`updated_at` | review 的版本 = 提交时间 |
| **resolve / unresolve 不移动评论的 `updated_at`**（实测前后一致） | 不需要为「解析不算编辑」加特判 |
| 删除的 Issue：Issue 与它的评论**都返回 404**（不是 500） | 判据改为「仓库本身还能读 → 视为删除」 |
| 账号没有 bot 标记：`fiume_bot` 的 `user.type` 仍是 `User` | 人机判定只能靠策略里的自动化账号名单 |
| `gt run list -b <branch>`、`gt repo view --json actions_enabled,default_branch` | 默认分支 CI 与 `unavailable` 判定可保留 |
| `--include` 把响应头打到 stderr | 仅在需要头时使用 |
| `gt schema <cmd>` 输出字段清单与类型 | 字段漂移用测试守住 |
| 冷启动 79ms，`gt notification list` 206ms | 每轮数进程，可接受 |

## 5. 方案

| 方案 | 内容 | 取舍 |
|---|---|---|
| A. `gt api` 透传 | 复用 `github*.ts`，只换 HTTP 层 | 仍需自写 Gitea→GitHub 形状 normalizer，与动机冲突 |
| B. 全原生子命令 | 全部走 `gt` 子命令 | 仓库级 issue 评论流无原生命令，做不到 100% |
| **C. 原生优先，`gt api` 兜底（选中）** | 通知/issue/PR/行内评审/检查/运行/写入走原生；仅「仓库级 issue 评论流」与「raw 文件」用 `gt api` | 官方契约覆盖绝大部分，回落面小 |

**核心改造（由 Gitea-only 与完整公民决定）**：

- D1. `Deployment.github` 由必选变可选，新增可选 `gitea`；`deployment.repository` 下沉到各自槽位。
- D2. `Setup` 从「一个全局 problem 暂停整个 runtime」改为**每来源一个 problem**，各来源等自己的 `ready`；都没有配成时才整体未就绪。
- D3. 票面路径按 `source` 分派（见 §6.5）。
- D4. worker 环境按实际存在的来源生成 shim 与 git 凭据。

## 6. 设计

### 6.1 模块

| 文件 | 职责 |
|---|---|
| `src/infra/gt.ts` | `Gt` 传输：cli 路径、`GITEA_CLI_CONFIG_DIR`、`--host`/`-R`/`--no-input`/`GITEA_CLI_ERROR_FORMAT=json`、超时 90s、错误 JSON → `CliError`（code 取 `status`）；`checks()` 区分「CI 失败」与「命令失败」 |
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

（main 上 `GithubAccountsSchema` 只有 `repository` 和 `cli`；gitea 字段显式定义。）

```ts
const GiteaConfigSchema = z.object({
  baseUrl, credentialFile, commitEmail, repository, cli,
  pollSeconds: 60..3600 default 60, failuresBeforeError: 1..20 default 3,
  observeIssues, observePulls, observeComments, observeCi: boolean default false,
}).strict()
```

- `credentialFile`：绝对路径，只放该账号的 token。setup 用它跑一次 `gt auth login --host … --with-token <file> --credential-store file`（`gt api user` 已可用则跳过）。token 不进设置、不进环境变量。
- `commitEmail`：可空；空时取 `gt api user` 的 email；仍缺失时合成 `<login>@noreply.<host>`（Gitea 没有 noreply 查询）。
- `cli`：`gt` 的绝对路径或命令名。

`resolveDeploymentGitea`：`gt version`（≥ 2.0）→ `gt api version`（实例 ≥ 28）→ 登录态与 token 的 notification scope → 仓库可读且 `permissions.push` → `default_branch`/`actions_enabled`。

### 6.3 Gitea-only 与双来源

- `Setup` 为每个来源维护 `problems: Partial<Record<SourceId, SetupProblem>>`；单个来源失败只影响它自己。
- `SourceRegistry` 的「无存储即 enabled」默认值必须显式处理：**gitea kind 未配置时视为关闭**，setup 不探测；与 tea 版 fork 的做法一致（新来源先是关闭的，填好再打开）。
- `writeEnvironment` 按存在的来源生成：`gt` shim（带 `GITEA_CLI_CONFIG_DIR`）、`gh` shim（有 github 时才写）、git credential 两条、blocked 命令提示改成不带账号名的通用说法。
- 启动自检：`git credential fill`（host = 实例域名）必须返回账号与密码，否则 `SetupError`，提示 `gt auth setup-git`。

### 6.4 轮次（与 github kind 同构，只换命令）

| 通道 | github 现状 | gitea |
|---|---|---|
| 通知 | `notifications?all=true&since=` + 仓库过滤 + ETag | `gt notification list --since=<cursor> --status unread,read,pinned --json=id,number,type,state,unread,updated_at,title`；仓库级端点，去掉过滤 |
| 通知详情 | issue/PR 正文 + 三路评论 | `gt issue view`/`gt pr view` + `gt api repos/{o}/{r}/issues/<n>/comments?limit=50&page=` + `gt pr review comments <n>` + `gt pr review list <n>` |
| 仓库事件流 | issues / issues-comments / review-comments | `gt issue list --kind all --state all --since=<cursor>` + `gt api repos/{o}/{r}/issues/comments?since=&limit=50`；**行内评论无仓库级流**，靠通知与线程轮询 |
| 已订阅线程 | 逐个 PR 拉检查 | `gt pr view` + `gt pr checks`（按 §6.4.3 判定） |
| 默认分支 CI | default_branch → commit → checks/statuses 合流 | `gt repo view --json default_branch,actions_enabled` + `gt run list -b <branch> --json=branch,commit,status,conclusion` |
| 失败重试 | `KV.github.retries` 24h 窗口 | 同构，键为 `KV.gitea.*` |

**6.4.1 通知游标重叠 = 2 分钟**

tea 版 fork 踩过一个真坑：Gitea 的通知在事件之后约 6 秒才写入（GitHub 22–24 秒），而游标只回退 5 秒时，中间那一轮既列不到通知、也读不到它指向的内容，**消息被永久丢掉**（他们因此丢过一条 Issue 正文）。本设计把重叠从 `cursorAt` 的 5 秒改为 `NOTIFICATION_OVERLAP_MS = 120_000`（与 fork 的结论一致）；重复读到的内容靠 Trigger ID 幂等去重。

`ponytail: 120s 重叠让每轮多列出约 2 分钟内的通知，重复项由幂等吸收；若实例很忙再调大`。

**6.4.2 分页**

- 原生子命令：gt 自己翻页（`--limit` 上限 1000），不手写分页。
- `gt api` 回落路径：每页 `limit=50`（实例 `max_response_items`），**按 `X-Total-Count` 翻页**（这些端点没有 `Link`）；单次读取最多 20 页，超限则**整次读取失败且不推进游标**（与 fork 的取舍一致）。

**6.4.3 检查与 CI 事实**

- 数据源只有 `gt pr checks --json=name,state,sha,url`：Gitea 的 Actions 与 commit status 由 gt 合流。
- 退出码：0 通过 / 8 待定 / 1 有失败；**exit 1 且 stderr 有 JSON = 命令失败**（不当成 CI 失败）。
- 状态映射：`success` 通过、`pending` 待定、`failure`/`error` 失败；**其它（含 `warning`）既不失败也不通过**，只计入「有该检查」。
- `unavailable` 事实改用 `gt repo view --json actions_enabled` + 检查列表为空判定。

### 6.5 完整公民：按来源分派

在 `SourceKind` 上增加一个可选能力（两个实现，不是抽象工厂）：

```ts
interface RepositorySource {
  pullNumber(thread: string): number | undefined
  readPull(ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull>
  claimPull(ctx: SourceContext, ticketId: string, pull: Pull): string | undefined
  endNotices(ctx: SourceContext, pulls: Pull[]): Promise<void>
  readPath(ctx: SourceContext, path: string, signal?: AbortSignal): Promise<string>
}
interface SourceKind { repository?: RepositorySource }
```

改造点（改为按 `source` 取 kind 上的 `repository`）：

| 位置 | 现状 | 改法 |
|---|---|---|
| `github-pull.ts` `pullOf/pullsOf` | 只认 `github:` | 从 registry 取对应 kind |
| `app/cards.ts` `ticketCard` | 用 `pullOf` | 同上，PR 摘要按来源渲染 |
| `app/tools/executor.ts` `orchestrator_report` | 直接 `host.github` | 按工单的 `source` 取 |
| `github-pull.ts` `pullEndNotices` + `app/runtime.ts` | 写死 github.com URL、只跳 github 频道 | 由 `repository.endNotices` 提供 |
| `app/assessment.ts` `readRepositoryPath` | 只见 github | 由 `repository.readPath` 提供 |
| `app/resources.ts` | 只注册 `github/` | 按存在的来源注册 `gitea/` |
| `app/prompts.ts` / `app/sessions.ts` | `skill/github` 常驻 | 按来源启用，新增 `skill/gitea` |

### 6.6 触发与写入

- 线程前缀 `gitea:<number>`、`gitea:ci:<branch>`；触发 ID 用 `key('gitea-issue' | 'gitea-ci', …)`。
- 通知直接给 `number` + `type`，不需要从 URL 反解；仍保留解析器处理历史地址。
- **人机判定**：Gitea 没有 bot 标记，判定只用策略里的「自动化账号」名单（`github` kind 的 `bots` 名单同构），不用 `user.type`。
- **review 版本 = `submitted_at`**；行内评论版本 = `created_at`（resolve 不改时间，无需特判）。
- **行内回复先算线程根**：同 `path` + 同 `line` 的最早一条为根，再 `gt pr review reply <pr> <root> -F -`。gt 会把 id 原样发给 `comments/<id>/replies`，不做根解析。
- 幂等：保留 `<!-- dsh-superagent:<message id> -->` marker，发送前查最近的评论。

### 6.7 读资源与面板

- `gitea/` 读资源走 `gt api repos/{o}/{r}/raw/<path>`（可选：记住 ETag 用 `If-None-Match`）。
- 面板新增 `source.gitea`、`health.gitea`、工单链接图标、设置卡片。
- 环境变量：`DSH_SUPERAGENT_GITEA_URL`、`DSH_SUPERAGENT_GITEA_REPOSITORY`、`DSH_SUPERAGENT_GITEA_ACCOUNT`。

### 6.8 KV

`KV.github` 的五个键（`since`、`retries`、`stream(id)`、`cursor(n)`、`branchCi`）在 `KV.gitea` 下镜像。

## 7. 与 tea 版 fork 的对照

参考仓库：`TechBlueprints/dsh-superagent-prototype`（同源 fork，用 `tea` 实现 Gitea，33 个提交）。它的核心改造与本设计 D1–D4 一一对应，其踩坑清单在**当前版本**（Gitea 28.4 + gt 2.0）的复核结果：

| 他们的坑 | 当前版本 | 本设计的处理 |
|---|---|---|
| 通知写入延迟导致丢消息（游标只回退 5s） | 时间戳语义不变，风险仍在（本机无法触发他人事件，未能实测） | 重叠改 2 分钟（§6.4.1） |
| 行内评论没有 `in_reply_to`，线程根要自算 | **仍存在**（实测回复后列表扁平、无 parent） | 自算根（§6.6） |
| 每页最多 50、评论列表只有 X-Total-Count | **仍存在**（`max_response_items: 50`） | §6.4.2 |
| 没有 bot 标记 | **仍存在**（`fiume_bot` 的 `type` 是 `User`） | 只用策略名单（§6.6） |
| resolve / dismiss 会移动 `updated_at` | **已消失**（实测 resolve/unresolve 前后不变） | 不需要特判 |
| 删除的 Issue 评论返回 500 | **已消失**（Issue 与评论都返回 404） | 判据改为「仓库可读即视为删除」 |
| 行内评论地址在 `/pulls/<n>/files#…` | **已变化**（现在是 `/pulls/<n>#issuecomment-<id>`） | 按实测渲染链接 |
| `warning` 检查状态 | 接受并原样返回 | 未知状态不失败不通过（§6.4.3） |

他们比本设计多做的（本设计列为开放项）：webhook 唤醒 `POST sources/:id/poll` 与 `pollSeconds` 到 86400、多实例与 `owner/*` 通配、面板增删来源、资源前缀 `<forge>/…`。

## 8. 待验证与风险（写进启用须知）

1. **429/限流**：测试实例未开限流。设计用失败指数退避（30s → 2× → 上限 15min）；须知说明「空转约 3 请求/轮，开启限流的实例请把 `pollSeconds` 调到 ≥ 60」。
2. **`gt auth git-credential` 未列入 `gt auth --help`**：2.x 可能改名；启动自检兜底。
3. **Windows 路径转义**：helper 行里是 `!GITEA_CLI_CONFIG_DIR=C:\\… gt.exe auth git-credential`，worker 配置照抄该格式。
4. **字段漂移**：用 `gt schema` 生成断言测试。
5. **版本门槛**：`gt` ≥ 2.0、实例 ≥ Gitea 28，不满足只让该来源报错。

## 9. 测试

- 单元：触发映射、地址、marker 幂等、检查状态映射（含 `warning`）、通知 2 分钟重叠的重复读去重、exit 1 两种含义的区分、行内评论根计算。
- schema 守卫：读 `gt schema` 断言消费的字段存在。
- 核心改造回归：github 单独、gitea 单独、两者同时，三种部署都能起、`ticketCard` 都能显示 PR。
- live（可选）：`tests/gitea-live.spec.ts`，覆盖通知→触发、评论写入、行内回复（含根）、`pr checks` 退出码、`run list`。

## 10. 留给 builder 的开放项

- 「评审结论」（approve / request changes）作为独立触发还是并入评论文本。
- 默认分支 CI 是否与通知共用 `pollSeconds`（建议共用）。
- `gitea/` 读资源的 ETag 缓存是否进入本次范围（建议否）。
- webhook 唤醒与多实例/`owner/*`：本设计不做，但接口上不与它们冲突（`RepositorySource` 与实例 id 无关）。

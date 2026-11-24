# Gitea Source kind（基于 gt CLI）设计

- 日期：2026-11-24（v4：同步约束、凭据简化、观察流确定实现）
- 分支：`kind/gitea-gt`（fork 自 `main`）
- 状态：待评审

## 1. 意图

新增与 `github`、`feishu` 并列的 **`gitea` Source kind**，只通过 Gitea 官方 CLI `gt`（gitea-cli ≥ 2.0）与实例交互；Gitea **可以单独使用**（不需要任何 GitHub 账号），且 Gitea 工单是**完整公民**。

动机是可维护性：手写的 REST 封装会随上游漂移，官方 CLI 的字段契约由上游承担。同类平台优先用官方客户端，不自己维护传输层。

**本仓库是源仓库的 fork，需要长期跟随上游。** 因此 gitea 的一切实现只做加法：新增文件承载逻辑，改既有文件只留最小的挂点（见 §7）。

## 2. 目标

1. `gitea` kind 与 `github` kind 能力对等：通知 → 详情 → 仓库事件流观察 → 已订阅线程轮询 → 触发准入 → 原会话回话。
2. **Gitea-only**：只配置 Gitea 就能起完整功能，GitHub 不安装、不配置也不阻塞。
3. **完整公民**：Gitea 工单的 PR 出现在 `ticketCard`、可被 `claimPull`、`orchestrator_report` 可读、PR 结束有通知、评估器可读仓库文件、worker 有 `gitea/` 资源与 `gitea` 技能。
4. **观察开关与 github kind 对齐**：`observeIssues` / `observePulls` / `observeComments` / `observeCi` 都实现。
5. 两个仓库来源可以同时启用。

## 3. 非目标

- **自动合并**：`main` 的 `github` kind 无合并闸门，本 kind 同等（`gt pr merge --match-head-commit` 留作后续）。
- **标记已读**：不调用 `gt notification mark-read`。`ponytail: 不标已读，收件箱会一直显示未读；日后要清理再加`。
- **worker 的 `gh` 兼容壳**：gitea worker 用 `gt`，不伪装成 `gh`。
- **改写 `github` kind 的内部结构**：不抽通用 `forge*` 层，`github*.ts` 保持原样（见 §7）。
- **webhook 唤醒与多实例**：见 §11 开放项。

## 4. 约束（Gitea 28.4.0 / gt 2.0.0 实测）

| 事实 | 影响 |
|---|---|
| `GITEA_CLI_CONFIG_DIR` 完全隔离 config/hosts/credentials | 每 profile 一份，不碰操作员环境 |
| 未登录 exit **4** + `{"error":{"code":4,"kind":"authentication"}}` | 错误映射可靠 |
| `--credential-store` 默认 keyring | 操作员登录时必须显式 `file` |
| `gt auth setup-git` 写 `helper = !GITEA_CLI_CONFIG_DIR=… gt auth git-credential --host …`；隔离 `GIT_CONFIG_GLOBAL` 下 `git credential fill` 实测返回账号+token | push 凭据可接；该 helper 是半隐藏接口 |
| `--json` 必须显式列字段 | 所有调用写字段清单 |
| 通知端点是仓库级 `/repos/{o}/{r}/notifications`（`limit/page/status-types/since`） | 无需再按仓库过滤 |
| 同线程新活动刷新同一条通知的 `updated_at`（id 不变），行内评论同样刷新；**通知的 `updated_at` 等于事件发生时间** | `--since` 能拉到增量 |
| 通知 `--status` 默认 `[unread,pinned]` | 必须写 `unread,read,pinned` |
| 列表端点**无 ETag** | 放弃条件轮询 |
| `/notifications` 有 `Link`；issues/comments 只有 `X-Total-Count` | 见 §6.4.2 |
| 实例 `GET /api/v1/settings/api` → **`max_response_items: 50`** | 每页最多 50，`gt api` 路径必须遵守 |
| `gt issue list` `--state` 默认 `open`，支持 `--since`/`--kind`，**按 updated_at 降序** | 必须 `--state all`；游标取 max(updated_at) |
| **不存在** `/pulls/comments` 与 `/pulls/{n}/comments`；行内评论在 `/pulls/{n}/reviews/{id}/comments` | 不能照搬 GitHub 路径 |
| 行内评论**没有父指针**；线程根 = 同一文件同一行的最早一条 | 回复前必须自己算根 |
| raw API 的行内评论 `line` 常为 `null`，`gt pr review comments` 给出真实 `line` | 根匹配用 gt 字段 |
| 行内评论 `html_url` 是 `/pulls/<n>#issuecomment-<id>` | 链接按此渲染 |
| `gt pr checks` 合并 Actions 与 commit status；**exit 1 = 有失败、8 = 有待定、0 = 通过** | CI 单一来源 |
| **exit 1 的歧义用流区分**：CI 失败 → stdout 有 JSON、stderr 空；命令失败 → stdout 空、stderr 有 JSON；未知 flag → exit 2 | 无需解析错误文本 |
| 检查状态接受 `warning` | 未知状态「不失败、不通过」 |
| `gt pr review list --json` 提供 `submitted_at`，无 `created_at`/`updated_at` | review 版本 = 提交时间 |
| resolve / unresolve **不移动**评论的 `updated_at` | 无需特判 |
| 删除的 Issue 与它的评论**都返回 404** | 「仓库可读 → 视为删除」 |
| 账号没有 bot 标记（`fume_bot` 的 `type` 是 `User`） | 人机判定只用策略的自动化账号名单 |
| `gt run list -b <branch>`、`gt repo view --json actions_enabled,default_branch` | 默认分支 CI 与 `unavailable` 判定 |
| `--include` 把响应头打到 stderr | 仅在需要头时使用 |
| `gt schema <cmd>` 输出字段清单与类型 | 字段漂移用测试守住 |
| 冷启动 79ms，`gt notification list` 206ms | 每轮数进程，可接受 |

## 5. 方案

| 方案 | 内容 | 取舍 |
|---|---|---|
| A. `gt api` 透传 | 复用 `github*.ts`，只换 HTTP 层 | 仍需自写 Gitea→GitHub 形状的 normalizer |
| B. 全原生子命令 | 全部走 `gt` 子命令 | 仓库级 issue 评论流无原生命令 |
| **C. 原生优先，`gt api` 兜底（选中）** | 通知/issue/PR/行内评审/检查/运行/写入走原生；仅「仓库级 issue 评论流」与「raw 文件」用 `gt api` | 官方契约覆盖绝大部分 |

**核心改造**（每项都只做加法，见 §7）：

- D1. `Deployment.github` 变可选，新增可选 `gitea`；`deployment.repository` 下沉到各自槽位。
- D2. `Setup` 从「一个全局 problem 暂停整个 runtime」改为**每来源一个 problem**。
- D3. 票面路径按 `source` 分派（§6.5）。
- D4. worker 环境按实际存在的来源生成 shim 与 git 凭据。

## 6. 设计

### 6.1 模块

| 文件 | 职责 |
|---|---|
| `src/infra/gt.ts` | `Gt` 传输：cli 路径、`GITEA_CLI_CONFIG_DIR`、`--host`/`-R`/`--no-input`/`GITEA_CLI_ERROR_FORMAT=json`、超时 90s、错误 JSON → `CliError`（code 取 `status`）；`checks()` 区分 CI 失败与命令失败 |
| `src/deployment-gitea.ts` | `GiteaAccountsSchema` 与 `resolveDeploymentGitea`（不写进 `deployment.ts`，减少挂点） |
| `src/sources/gitea.ts` | kind 描述符、配置 schema、轮次循环 |
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

const GiteaConfigSchema = z.object({
  baseUrl, commitEmail, repository, cli,          // 无 credentialFile：DSH 不碰 token
  pollSeconds: 60..3600 default 60, failuresBeforeError: 1..20 default 3,
  observeIssues, observePulls, observeComments, observeCi: boolean default false,
}).strict()
```

- **登录由操作员完成**，DSH 只验证：
  ```sh
  GITEA_CLI_CONFIG_DIR=<stateDir>/gitea-cli gt auth login --host <url> --with-token <tokenfile> --credential-store file
  ```
  DSH 不读 token、不存 token、不代跑这条命令。
- `commitEmail`：可空；空时取 `gt api user` 的 email，仍缺失则合成 `<login>@noreply.<host>`。
- `cli`：`gt` 的绝对路径或命令名。

`resolveDeploymentGitea`：`gt version`（≥ 2.0）→ `gt api version`（实例 ≥ 28）→ 登录态与 notification scope → 仓库可读且 `permissions.push` → `default_branch`/`actions_enabled`。

**未登录时的提醒**（这是去掉 `credentialFile` 后必须保留的部分）：

1. 保存设置时探测失败 → `SetupError('giteaNotLoggedIn')`，**只挂在 Gitea 这张卡片上**
2. 卡片显示红字 + 上面那条命令 + 「重新检查」按钮
3. 该来源 health 停 `state: 'error'`，详情「未登录 Gitea 实例 <url>」
4. GitHub / 飞书 不受影响（D2 的用处）
5. 操作员跑完命令点「重新检查」或重启即转 ready

### 6.3 Gitea-only 与双来源

- `Setup` 为每个来源维护 `problems: Partial<Record<SourceId, SetupProblem>>`；单个来源失败只影响自己，都没有配成才整体未就绪。
- `SourceRegistry` 的「无存储即 enabled」：**gitea 未配置时视为关闭**，setup 不探测。
- `writeEnvironment` 按存在的来源生成：`gt` shim（带 `GITEA_CLI_CONFIG_DIR`）、`gh` shim（有 github 才写）、git credential 两条、blocked 命令提示改成不带账号名的通用说法。
- 启动自检：`git credential fill`（host = 实例域名）必须返回账号与密码，否则 `SetupError`，提示 `gt auth setup-git`。

### 6.4 轮次

| 通道 | github 现状 | gitea |
|---|---|---|
| 通知 | `notifications?all=true&since=` + 仓库过滤 + ETag | `gt notification list --since=<cursor> --status unread,read,pinned --json=id,number,type,state,unread,updated_at,title` |
| 通知详情 | issue/PR 正文 + 三路评论 | `gt issue view`/`gt pr view` + `gt api repos/{o}/{r}/issues/<n>/comments?limit=50&page=` + `gt pr review comments <n>` + `gt pr review list <n>` |
| 事件流：新 Issue / 新 PR | `issues?state=all` | `gt issue list --kind all --state all --since=<cursor>` |
| 事件流：评论 | `issues/comments` + `pulls/comments` | `gt api repos/{o}/{r}/issues/comments?since=&limit=50`；**行内评论无仓库级流**，只能经通知与线程轮询 |
| 已订阅线程 | 逐个 PR 拉检查 | `gt pr view` + `gt pr checks`（§6.4.3） |
| 默认分支 CI | default_branch → commit → checks | `gt repo view --json default_branch,actions_enabled` + `gt run list -b <branch> --json=branch,commit,status,conclusion` |
| 失败重试 | `KV.github.retries` 24h 窗口 | 同构，键为 `KV.gitea.*` |

`observeComments` 的文案要如实：打开后覆盖**会话评论**；行内评审评论始终只经通知送达。字段 hint 与策略表格的说明按此措辞。

**6.4.1 通知游标重叠 = 2 分钟**

Gitea 的通知在事件后约 6 秒才写入（GitHub 22–24 秒），游标只回退 5 秒时中间那轮既列不到通知也读不到它指向的内容，消息会永久丢失。重叠取 `NOTIFICATION_OVERLAP_MS = 120_000`，重复读到的内容靠 Trigger ID 幂等去重。

`ponytail: 120s 重叠让每轮多列约 2 分钟的通知，重复项由幂等吸收；实例很忙再调大`。

**6.4.2 分页**

- 原生子命令：gt 自己翻页（`--limit` 上限 1000）。
- `gt api` 回落：每页 `limit=50`（实例 `max_response_items`），按 `X-Total-Count` 翻页；单次读取最多 20 页，超限则整次读取失败且不推进游标。

**6.4.3 检查与 CI 事实**

- 数据源只有 `gt pr checks --json=name,state,sha,url`（Actions 与 commit status 由 gt 合流）。
- 退出码：0 通过 / 8 待定 / 1 有失败；**exit 1 且 stderr 有 JSON = 命令失败**，不当成 CI 失败。
- 状态：`success` 通过、`pending` 待定、`failure`/`error` 失败；其它（含 `warning`）既不失败也不通过。
- `unavailable` 用 `gt repo view --json actions_enabled` + 检查列表为空判定。

### 6.5 完整公民：按来源分派

`SourceKind` 增加一个可选能力（两个实现）：

```ts
interface RepositorySource {
  readPull(ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull>
  claimPull(ctx: SourceContext, ticketId: string, pull: Pull): string | undefined
  endNotices(ctx: SourceContext, pulls: Pull[]): Promise<void>
  readPath(ctx: SourceContext, path: string, signal?: AbortSignal): Promise<string>
}
interface SourceKind { repository?: RepositorySource }
```

线程键 `<source>:<number>` 的解析不进这个接口：它不依赖任何来源能力。core 里已有 `threadKey(ref)` 负责拼，在它旁边加 `threadNumber(thread)` 负责拆，`github-pull.ts` 里现有的私有 `pullNumber` 改用它（仓库里已有 4 处各写一遍同样的切分）。

改造点（都收敛到同一个 helper `repositoryOf(sources, sourceId)`）：

| 位置 | 现状 | 改法 |
|---|---|---|
| `github-pull.ts` `pullOf/pullsOf` | 只认 `github:` | 用 `threadNumber` + 来源 id |
| `app/cards.ts` `ticketCard` | 用 `pullOf` | 同上 |
| `app/tools/executor.ts` `orchestrator_report` | 直接 `host.github` | 按工单的 `source` 取 |
| `pullEndNotices` + `app/runtime.ts` | 写死 github.com URL、只跳 github 频道 | 由 `repository.endNotices` 提供 |
| `app/assessment.ts` `readRepositoryPath` | 只见 github | 由 `repository.readPath` 提供 |
| `app/resources.ts` | 只注册 `github/` | 按存在的来源注册 `gitea/` |
| `app/prompts.ts` / `app/sessions.ts` | `skill/github` 常驻 | 按来源启用，加 `skill/gitea` |

### 6.6 触发与写入

- 线程前缀 `gitea:<number>`、`gitea:ci:<branch>`；触发 ID `key('gitea-issue' | 'gitea-ci', …)`。
- 通知直接给 `number` + `type`，不从 URL 反解。
- 人机判定只用策略的自动化账号名单，不用 `user.type`。
- review 版本 = `submitted_at`；行内评论版本 = `created_at`。
- 行内回复先算线程根（同 `path` + 同 `line` 的最早一条），再 `gt pr review reply <pr> <root> -F -`。
- 幂等：保留 `<!-- dsh-superagent:<message id> -->` marker，发送前查最近的评论。

### 6.7 读资源与面板

- `gitea/` 读资源走 `gt api repos/{o}/{r}/raw/<path>`。
- 面板新增 `source.gitea`、`health.gitea`、工单链接图标、设置卡片。
- 环境变量：`DSH_SUPERAGENT_GITEA_URL`、`DSH_SUPERAGENT_GITEA_REPOSITORY`、`DSH_SUPERAGENT_GITEA_ACCOUNT`。

### 6.8 KV

`KV.github` 的五个键（`since`、`retries`、`stream(id)`、`cursor(n)`、`branchCi`）在 `KV.gitea` 下镜像。

## 7. 与源分支同步（约束）

本仓库是源仓库的 fork，会持续 `git merge upstream/main`。因此：

1. **只做加法**：`github*.ts` 内部不改写，不抽通用 `forge*` 层。
2. **挂点最小**：每个既有文件的改动控制在几行，能放在新文件里的都放新文件（`deployment-gitea.ts`）。
3. **分派收敛**：按来源取实现统一走 `repositoryOf(sources, sourceId)`，上游改动时只需对齐这一处。
4. **合并用 merge 不用 rebase**，保留 gitea 的提交边界；合并后跑三态回归（只 github / 只 gitea / 两者）。

侵入点清单（约 60–80 行，散在 12 个文件）：

| 文件 | 挂点 | 量级 |
|---|---|---|
| `deployment.ts` | `github?`、`gitea?` 两个可选字段 | ~6 行 |
| `setup.ts` | 全局 problem → 每来源 problem | ~10 行 |
| `app/runtime.ts` | 读 problem 处 | ~5 行 |
| `infra/environment.ts` | 按存在的来源生成 shim | ~15 行 |
| `infra/commands.ts` | `gt` 访问器 | ~5 行 |
| `sources/github-pull.ts` | 去掉写死的 github | ~10 行 |
| `cards.ts` / `tools/executor.ts` / `assessment.ts` | 各取一次实现 | 各 1–3 行 |
| `resources.ts` / `prompts.ts` / `sessions.ts` / `context.ts` / `skill-files.ts` | 各加一项 | 各 1–3 行 |
| `registry.ts` / `kind.ts` / `kv.ts` / `locales.ts` | 追加字段与键 | 纯追加 |

## 8. 与 tea 版 fork 的对照

参考 `TechBlueprints/dsh-superagent-prototype`（同源 fork，用 `tea` 实现 Gitea）。其踩坑在当前版本（Gitea 28.4 + gt 2.0）复核后**仍存在**的是：通知写入延迟（§6.4.1）、行内评论无父指针（§6.6）、每页 50 与 X-Total-Count（§6.4.2）、没有 bot 标记（§6.6）。**已消失**的是：resolve 移动 `updated_at`、删除 Issue 评论返回 500、`/files#` 地址形态——当前版本无需为它们加代码。

## 9. 待验证与风险（写进启用须知）

1. **429/限流**：测试实例未开限流。设计用失败指数退避（30s → 2× → 上限 15min）；须知说明「空转约 3 请求/轮，开启限流的实例请把 `pollSeconds` 调到 ≥ 60」。
2. **`gt auth git-credential` 未列入 `gt auth --help`**：2.x 可能改名；启动自检兜底。
3. **Windows 路径转义**：helper 行里是 `!GITEA_CLI_CONFIG_DIR=C:\\… gt.exe auth git-credential`，worker 配置照抄。
4. **字段漂移**：用 `gt schema` 生成断言测试。
5. **版本门槛**：`gt` ≥ 2.0、实例 ≥ Gitea 28，不满足只让该来源报错。

## 10. 测试

- 单元：触发映射、地址、marker 幂等、检查状态映射（含 `warning`）、2 分钟重叠的重复读去重、exit 1 两种含义、行内评论根计算、`threadNumber`。
- schema 守卫：读 `gt schema` 断言消费的字段存在。
- 三态回归：github 单独 / gitea 单独 / 两者同时，都能起且 `ticketCard` 显示 PR。
- live（可选）：`tests/gitea-live.spec.ts`，覆盖通知→触发、评论写入、行内回复（含根）、`pr checks` 退出码、`run list`。

## 11. 开放项

- 「评审结论」（approve / request changes）作为独立触发还是并入评论文本。
- 默认分支 CI 是否与通知共用 `pollSeconds`（建议共用）。
- webhook 唤醒与多实例/`owner/*`：本设计不做，但 `RepositorySource` 与实例 id 无关，不与它们冲突。

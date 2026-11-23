# Gitea Source kind（基于 gt CLI）设计

- 日期：2026-11-23
- 分支：`kind/gitea-gt`（fork 自 `main`）
- 状态：待评审

## 1. 意图

新增一个与 `github`、`feishu` 并列的 **`gitea` Source kind**，只通过 Gitea 官方 CLI `gt`（gitea-cli ≥ 2.0）与实例交互。

动机是**可维护性**：现有分支 `forgejo-17` 用自维护的 REST 封装（`forgejo.ts` / `forge-cli.ts` / `forgejo-merge.ts`，约 580 行）适配 Gitea。个人维护的 API 封装会随上游漂移，而官方 CLI 的字段契约由上游承担。本分支的出发点是「同类平台用官方 CLI，不自己写传输层」。

## 2. 目标

- `gitea` kind 的行为与 `github` kind 一一对应：通知唤醒 → 逐条拉详情 → 仓库事件流观察 → 已订阅线程轮询 → 触发进入准入闸门 → 在原始会话回话。
- 允许与 `github` kind **同时启用**（两个仓库来源并存）。
- 所有 Gitea 读取/写入优先走 `gt` 原生子命令；只有在没有原生命令时才回落 `gt api`。
- 复用 `github` kind 的轮次模型、游标、重试、健康报告，不新造一套调度。

## 3. 非目标

- **Forgejo**：`gt` 不支持 Forgejo，本 kind 只服务 Gitea ≥ 28。`forgejo-17` 分支的工作与本文无关。
- **自动合并**：`main` 上的 `github` kind 不含合并闸门，本 kind 保持同等能力（`gt pr merge --match-head-commit` 留作后续能力，不在本次范围）。
- **标记已读**：不调用 `gt notification mark-read`，不改动操作员收件箱状态，与 `github` kind 用 `all=true` 的行为对齐。`ponytail: 不标已读，收件箱会一直显示未读；若日后需要清理，再加 mark-read`。
- **worker 的 `gh` 兼容壳**：gitea worker 会话里用 `gt`，不伪装成 `gh`。
- **一个 kind 多个仓库**：仍是一个 kind 一个仓库（registry 的 `settings.sources` 以 kind id 为键）。

## 4. 约束（已在真实例上实测）

实例：Gitea **28.4.0**，CLI：**gt 2.0.0**（2026-11-18）。

| 事实 | 影响 |
|---|---|
| `GITEA_CLI_CONFIG_DIR` 完全隔离 config/hosts/credentials | 每个 profile 一份配置，不碰操作员环境 |
| 未登录时 exit **4** + `{"error":{"code":4,"kind":"authentication"}}` | 错误映射可靠 |
| `--credential-store` 默认 **keyring** | 必须显式 `file` |
| `gt auth setup-git` 写 `helper = !GITEA_CLI_CONFIG_DIR=… gt auth git-credential --host …`；隔离 `GIT_CONFIG_GLOBAL` 下 `git credential fill` 实测返回账号与 token | push 凭据可接；但 `gt auth git-credential` 是半隐藏接口 |
| `--json` 必须显式列字段（2.0 起） | 所有调用写字段清单 |
| 通知端点 `GET /repos/{o}/{r}/notifications`，参数 `limit`、`page`、`status-types`、`since` | 仓库级端点，**无需再按仓库过滤** |
| 同线程新活动刷新同一条通知的 `updated_at`（id 不变）；行内评审评论同样刷新 | `--since` 游标能拉到增量，行内评论无需仓库级流 |
| 通知默认 `--status` = `[unread,pinned]` | 必须写 `unread,read,pinned` |
| 所有列表端点**无 ETag**（/archive、/raw 除外） | 放弃条件轮询；轮次成本固定 |
| `/notifications` 有 `Link`；issues/comments 只有 `X-Total-Count` | 不依赖 `Link`，用「返回条数 == limit」判断翻页 |
| `gt issue list` 的 `--state` 默认 `open`，支持 `--since`、`--kind`，结果**按 updated_at 降序** | 必须 `--state all`；游标取 max(updated_at) |
| **不存在** `/repos/{o}/{r}/pulls/comments`，也**不存在** `/pulls/{n}/comments`；行内评论在 `/pulls/{n}/reviews/{id}/comments` | 不能照搬 GitHub 端点路径；用 `gt pr review comments <n>` |
| `gt pr checks` 合并 Actions 与 commit status；退出码 **1 失败 > 8 待定 > 0 通过**；`--required` 在分支无必需检查时报错 exit 1 | CI 单一来源 |
| `gt run list -b <branch>`、`gt repo view --json actions_enabled,default_branch` | 默认分支 CI 与 `unavailable` 判定可保留 |
| `--include` 把响应头打到 **stderr** | 只在需要头时使用 |
| `gt pr review comments/reply/resolve` 存在 | 行内讨论可读可回 |
| `gt schema <cmd>` 输出机器可读字段清单 | 字段漂移可用测试守住 |
| 冷启动 `gt version` 79ms，`gt notification list` 206ms | 每轮数个进程，可接受 |

## 5. 方案

| 方案 | 内容 | 取舍 |
|---|---|---|
| A. `gt api` 透传 | 复用 `github*.ts` 逻辑，只换 HTTP 层 | 仍需自写 Gitea→GitHub 形状的 normalizer，与动机冲突 |
| B. 全原生子命令 | 所有读写走 `gt` 子命令 | 部分场景（仓库级 issue 评论流）没有原生命令，做不到 100% |
| **C. 原生优先，`gt api` 兜底（选中）** | 通知、issue/PR 列表、行内评审、检查、运行、评论写入走原生；只有「仓库级 issue 评论流」与「raw 文件」用 `gt api` | 官方契约覆盖绝大部分；回落面小且都是被动读取 |

选择 C：A 留下的 normalizer 正是要避免的自维护映射；B 在评论流上不可行。

## 6. 设计

### 6.1 模块

| 文件 | 职责 |
|---|---|
| `src/infra/gt.ts` | `Gt` 传输：定位 cli、注入 `GITEA_CLI_CONFIG_DIR`/`--host`/`-R`/`--no-input`/`GITEA_CLI_ERROR_FORMAT=json`、超时 90s、错误 JSON → `CliError`（code 取 `status`，无 status 时取退出码） |
| `src/sources/gitea.ts` | kind 描述符、配置 schema、轮次循环（与 `github.ts` 同构） |
| `src/sources/gitea-trigger.ts` | 线程/触发 ID、地址解析、`mentions`、人机判定 |
| `src/sources/gitea-read.ts` | PR/Issue/评论/检查/文件读取与事实投影 |
| `src/sources/gitea-pull.ts` | PR 观察、工单绑定、结束通知 |
| `src/sources/gitea-channel.ts` | 回复发送（带幂等 marker）、链接 |
| `skills/dsh-superagent-gitea/SKILL.md` | 教 worker 用 `gt` |

### 6.2 配置与部署

```ts
const GiteaConfigSchema = z.object({
  baseUrl, credentialFile, commitEmail, repository, cli,      // 与 GithubAccountsSchema 同名同义
  pollSeconds: 60..3600 default 60, failuresBeforeError: 1..20 default 3,
  observeIssues, observePulls, observeComments, observeCi: boolean default false,
}).strict()
```

`Deployment` 增加第二槽位：

```ts
interface Deployment {
  repository: string                 // 保持不变：github kind 的仓库
  github: { … }                      // 不变
  gitea?: { cli: string; login: string; noreply: string; baseUrl: string; configDir: string; repository: string; version: string }
  feishu?: FeishuBot
}
```

`gitea.repository` 与 `deployment.repository` 各自独立；现有读 `deployment.repository` 的代码路径（resources、executor、cards）保持不变，gitea 用自己的字段。

`resolveDeploymentGitea(machine, config, probe)`：`gt version` → `gt auth status --host`（或 `gt api user`）→ 仓库可读且 `permissions.push` → `default_branch`、`actions_enabled`。新增 `SETUP_FIELDS.gitea` 与对应 `SetupError` 代码 + locale 文案。

### 6.3 凭据与环境

- 操作员一次性：`GITEA_CLI_CONFIG_DIR=<stateDir>/gitea-cli gt auth login --host <url> --with-token <tokenfile> --credential-store file`。DSH 不复制、不读取该 token 之外的任何凭据。
- worker shim：`gt` → 真实二进制 + `GITEA_CLI_CONFIG_DIR`；`gh` 的 shim 继续指向 github 的 cli（两个 kind 并存时各自有效）。
- worker git 配置增加一条 `[credential "<gitea baseUrl>"] helper = !<cli> auth git-credential --host <url>`。`useHttpPath` 与 github 侧保持一致。
- **启动自检**：`git credential fill`（protocol=https, host=<实例>）必须返回账号与密码；失败则 `SetupError` 并在启用须知里指向 `gt auth setup-git`。这是对「`gt auth git-credential` 是半隐藏接口」的兜底。

### 6.4 轮次（与 github kind 同构，只换命令）

| 通道 | github 现状 | gitea |
|---|---|---|
| 通知 | `notifications?all=true&since=` + 按仓库过滤 + ETag | `gt notification list --since=<cursor> --status unread,read,pinned --limit 100 --json=id,number,type,state,unread,updated_at,title`；仓库级端点，**去掉仓库过滤** |
| 通知详情 | issue/PR 正文 + 三路评论 | `gt issue view <n>`/`gt pr view <n> --json=…` + `gt api repos/{o}/{r}/issues/<n>/comments?since=`（会话评论）+ `gt pr review comments <n>`（行内）+ `gt pr review list <n>`（评审结论） |
| 仓库事件流 | issues / issues-comments / review-comments 三路 | `gt issue list --kind all --state all --since=<cursor> --limit 100` + `gt api repos/{o}/{r}/issues/comments?since=`；**行内评论无仓库级流，靠通知与线程轮询** |
| 已订阅线程 | 逐个 PR 拉检查 | `gt pr view` + `gt pr checks` |
| 默认分支 CI | default_branch → commit → checks/statuses 合流 | `gt repo view --json default_branch,actions_enabled` + `gt run list -b <branch> --json=branch,commit,status,conclusion` |
| 失败重试 | `KV.github.retries` 24h 窗口 | 同构，键改为 `KV.gitea.*` |

游标与去重沿用：轮末原子提交 `cursorAt(round.started)`（-5s 重叠），Trigger ID 幂等。因为列表无 ETag 且按 updated_at 降序，游标取本页 `max(updated_at)`，与顺序无关。

### 6.5 触发、线程、地址

- 线程前缀 `gitea:<number>`；CI 线程 `gitea:ci:<branch>`。
- 触发 ID 用 `key('gitea-issue' | 'gitea-ci', …)`。
- 地址：`gt` 的通知直接给 `number` + `type`，**不需要**像 `githubAddress` 那样从 URL 反解；仍保留一个解析器用于历史消息与 `url` 型地址。
- 人机判定：Gitea 的 `user.type` 为 `User`/`Bot`；`isHumanLogin` 对应实现改成「`type === 'User'` 且非 `[bot]` 后缀」。

### 6.6 写入

| 目标 | 命令 |
|---|---|
| Issue/PR 会话评论 | `gt issue comment <n> -F -` / `gt pr comment <n> -F -` |
| 行内线程回复 | `gt pr review reply <pr> <comment-id> -F -` |
| 幂等 | 保留 `<!-- dsh-superagent:<message id> -->` marker；发送前先列一次最近评论查 marker（与 `sendGithub` 同构） |

### 6.7 读资源、面板、提示词

- `gitea/` 读资源：`gt api repos/{o}/{r}/raw/<path>`（**可选**：记住 ETag，用 `If-None-Match` 省下载；这是 Gitea 唯一支持条件请求的地方）。
- 面板：`source.gitea`、`health.gitea`、工单链接图标；`cards.ts` 的 `pullOf` 需要按来源取 PR 读取器。
- 提示词：`skill/gitea` 段落、`sourceSkills` 映射、`bundledSkills` 加载、`sessions.ts` 的白名单、`cli` 说明里改为「用 `gt`」。
- 环境变量：`DSH_SUPERAGENT_GITEA_URL`、`DSH_SUPERAGENT_GITEA_REPOSITORY`、`DSH_SUPERAGENT_GITEA_ACCOUNT`。

### 6.8 KV

`KV.github` 的五个键（`since`、`retries`、`stream(id)`、`cursor(n)`、`branchCi`）在 `KV.gitea` 下镜像一份。**不**改动 github 的键。

### 6.9 设置与迁移

- `SETUP_FIELDS.gitea` 新增；设置卡片新增一张。
- 新增 kind 无历史数据，不需要迁移；`migration.ts` 不动。

## 7. 待验证与风险（写入启用须知）

1. **429/限流**：测试实例未开启限流，`X-RateLimit-*` 未观察到。设计采用**失败指数退避**（30s → 2× → 上限 15min），并在启用须知里说明「开启限流的实例请把 `pollSeconds` 调到 ≥ 60；空转约 3 请求/轮」。
2. **`gt auth git-credential` 未列入 `gt auth --help`**：2.x 可能改名。启动自检兜底，失败时提示升级/调整。
3. **Windows 路径转义**：helper 行里是 `!GITEA_CLI_CONFIG_DIR=C:\\… gt.exe auth git-credential`，实测可用；worker 配置需照抄该格式。
4. **字段漂移**：`gt` 2.x 承诺不破坏 `--json` 字段，但仍用 `gt schema` 生成一次断言测试。
5. **版本门槛**：`gt` ≥ 2.0 且实例 ≥ Gitea 28，启动检查不满足即报错。

## 8. 测试

- 单元：触发器映射、地址解析、marker 幂等、检查状态 → CI 事实、通知增量（同 id 刷新的处理）。
- schema 守卫：一条测试读 `gt schema` 断言我们消费的字段都存在。
- live（可选、需实例）：`tests/gitea-live.spec.ts`，环境变量指向一个私有测试仓库，覆盖：通知 → 触发、评论写入、行内回复、`pr checks` 退出码、`run list`。参考测试仓库 `fiume_cui/dsh_superagent_test`（仅供本地验证，不写进仓库）。

## 9. 留给 builder 的开放项

- Gitea `user.type` 为空的实例如何判定人机。
- 「评审结论」（approve / request changes）是否作为独立触发类型，还是并入评论文本。
- 默认分支 CI 的轮询频率是否与通知轮询共用 `pollSeconds`（建议共用）。
- `gitea/` 读资源的 ETag 缓存是否进入本次范围（建议否，留作优化）。

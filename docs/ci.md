# 在 CI 中使用 aforge

自动化环境里 aforge 有三条会硬失败的路径，和一条值得设成门禁的推荐用法。单点行为的细节在各自的文档里，这篇只负责把它们串成一条能直接抄进流水线的流程：[命令速查](commands.md)、[learning](learning.md)、[平台注意事项](platform.md)。

## CI 是怎么被判定的

aforge 只认 `CI` 这一个环境变量（`src/core/env.ts` 的 `isTruthyCi`），**不认** `GITHUB_ACTIONS` / `GITLAB_CI` / `BUILD_ID` 之类：

| `CI` 的值 | 判定 |
|-----------|------|
| 未设置 / 空串 / 全空白 | 非 CI |
| `false` / `FALSE` / `0`（trim + 转小写后比较） | 非 CI |
| 其余任意非空值（`true` / `1` / `yes` / `on`，甚至 `no`） | CI |

`CI=0` 与 `CI=false` 被判为**非** CI 是最容易踩的一格：想在流水线里临时放开写入就设这两个值，但反过来，用 `CI=0` 表达「跑在 CI 里但关掉某些行为」不会起作用。

`CI` 在全仓只有一个消费者：`learnings/` 的写入路径（Spec §10）。它不影响渲染正文、不影响退出码、不影响其它任何命令——这是漂移门禁能成立的前提，下面会展开。

GitHub Actions / GitLab CI 自己会注入 `CI=true`。自建 runner、裸 `docker run`、本地 `act` 需要自己传。

## 能做什么，不能做什么

| 命令 | CI 里 |
|------|-------|
| `aforge sync` / `sync --dry-run` / `doctor` / `status` / `detect` / `learnings list` | 正常执行 |
| `aforge init`（不带 `-i`） | 正常执行——非 TTY 自动走静默路径，等价 `init --yes`（Spec §7.1） |
| `aforge init -i` | **必然失败**，退出码 2 |
| `aforge learn`（`CI` 为真时） | **必然失败**，退出码 2 |
| `aforge source add <git-url>` / `source update`（`AGF_OFFLINE=1` 时） | **必然失败**，退出码 5 |

三条失败路径的判据：

- **`learn` 被拒**：`createLearning` 是 `learnings/` 的唯一写入口，开头就检查 `CI`（`src/core/learning/store.ts`），报 `CI 环境禁止写入 learnings（检测到 CI=true）` → ConfigError(2)。`learning.auto_capture` 取任何值都绕不过它（Spec §10）。要在流水线里沉淀经验，只能把内容写进文件、由人在本地 `aforge learn`。
- **`init -i` 必炸**：`-i` 是「强制交互」，非 TTY 下**不静默降级**而是抛 ConfigError(2)，文案「当前环境不支持交互式输入（stdin/stdout 非 TTY，常见于 CI 与管道）」，hint 指向 `aforge init --yes`。判据是 stdin 与 stdout **都**为 TTY（`src/infra/prompt.ts` 的 `defaultTtyProbe`），所以本地 `aforge init -i | tee log.txt` 也会踩到。不带 `-i` 的 `aforge init` 在非 TTY 下自动走静默默认值，不会失败。
- **离线守卫**：`AGF_OFFLINE` 必须**严格等于字符串 `1`**（`src/core/env.ts`）——`true` / `yes` / `on` 一律无效。置位后只有 `source add git` 与 `source update` 会失败（退出码 5）；`sync` / `skill add` / `bundle import` / `template enable` 等纯本地操作照常，完整矩阵见 [Spec §7.8](../AgentForge-Spec.md#78-offline-降级矩阵)。

呈现层还有两点在 CI 里自动生效，不用管：非 TTY 下符号退回纯 ASCII、颜色默认关闭（要在 CI 日志里保留颜色就设 `FORCE_COLOR`），分档规则见 [平台注意事项](platform.md#windows)。`--json` 输出不经呈现层，逐字节稳定。

## 推荐用法：漂移门禁

值得在 CI 里跑的不是 `sync`，而是**验证投影产物与 SoT 一致**——防的是「有人改了 `.agentforge/` 却忘了 `aforge sync`，或者直接手改了 `AGENTS.md` 的 marker 区间」。

### 为什么 hash 跨环境可比

渲染正文与环境无关：`learning.auto_capture: prompt` 的 `## Learning Protocol` 段在 CI 里**照样渲染**（[learning](learning.md#让-agent-自己记learningauto_capture)），CI 只挡 `learn` 的写入。于是同一份 SoT 在 CI 与本机渲染出同一个 `contentHash`（LF 规范化的 sha256），`doctor` 的三方 hash 比对才不会把「跑在 CI 里」本身当成漂移。刻意如此：`renderRulesMd` 不接受 `EnvSnapshot`。

### 三个前置条件

门禁能不能生效，取决于仓库里有没有可比对的东西：

1. **投影产物必须提交进仓库**。`projection.gitignore_generated: true` 会把 `AGENTS.md` / `CLAUDE.md` 等写进 `.gitignore`（Spec §4.2），CI 里 checkout 出来就没有产物可比——要用门禁就别开这个开关。
2. **`.agentforge/sync-meta.json` 必须提交**。它是 `doctor` 三方比对里「上次 sync 记录」那一方，也是 `sync` 的 marker 冲突预检查的基准。它不在 `gitignore_generated` 写入的模式里（那段只写投影产物 + `.sync.lock/` / `.agf-backup/` / `.agf-backup-failed-*/`），默认就是可提交的。缺了它，`doctor` 一条 `projection-hash/*` 都不产出、`sync --dry-run` 也没有基准 → **门禁静默放行**。下面的脚本因此对「零条 `projection-hash`」也判失败。
3. **effective scope 必须是 `project`**。user scope 的投影落在用户目录，CI runner 上没有对应的仓库文件。

另有一条与平台相关：`projection.path_style` 缺省 `auto`，会按当前 OS 改写正文里的路径 token。若 SoT 素材里有路径（`%USERPROFILE%\...` / `$HOME/...`），在 Windows 上 sync、在 ubuntu runner 上校验就会得到不同的 `contentHash`，被误报成漂移。跨平台跑门禁请把 `path_style` 显式钉成 `windows` 或 `posix`，或者让门禁 job 与开发机同平台。

### workflow 片段

```yaml
name: agentforge-drift

on:
  pull_request:
  push:
    branches: [main]

# 同一 ref 只跑最新一次：aforge 命令必须串行，撞 .sync.lock 直接退出码 3
concurrency:
  group: agentforge-drift-${{ github.ref }}
  cancel-in-progress: true

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # 钉版本：aforge 升级可能改变渲染正文，浮动版本会让 contentHash 无故变化
      - run: npm i -g @zythegit/agentforge@0.2.2

      # ① marker 区间被手改过吗（退出码 3）。dry-run 零写入，也不取 .sync.lock
      - run: aforge sync --dry-run

      # ② 投影与 SoT 一致吗。漂移是 warn 级、聚合退出码为 0，必须解析 --json
      - name: check projection drift
        run: |
          aforge doctor --json > doctor.json
          node -e '
            const r = JSON.parse(require("node:fs").readFileSync("doctor.json", "utf8"));
            const hashes = r.results.filter((x) => x.item.startsWith("projection-hash"));
            const errors = r.results.filter((x) => x.level === "error");
            const drift = hashes.filter((x) => x.level !== "ok");
            if (hashes.length === 0) {
              console.error("no projection-hash results: is .agentforge/sync-meta.json committed?");
              process.exit(1);
            }
            for (const x of [...drift, ...errors]) console.error(`${x.level} ${x.item}: ${x.detail}`);
            if (drift.length > 0 || errors.length > 0) {
              console.error("projection is out of sync: run `aforge sync` locally and commit the result");
              process.exit(1);
            }
            console.log(`projection in sync (${hashes.length} file(s) checked)`);
          '
```

第 ①②步为什么都要留着：两者抓的是不同的东西。

| 情形 | `sync --dry-run` | `doctor --json` |
|------|------------------|-----------------|
| SoT 改了但没重新 sync | 退出码 **0**（预检查只比「磁盘区间 vs 上次记账」，两边都没变） | `projection-hash/<target>` = `warn`，detail「投影可能过期或被修改（SoT 在上次 sync 后已变更）」 |
| 投影文件的 marker 区间被手改 | 退出码 **3** | `projection-hash/<target>` = `warn`，detail「hash 不一致（投影与上次 sync 记录不符，可能被手动修改）」 |
| 投影文件不存在 / marker 段被删 | 退出码 0 | `warn`，detail「投影文件不存在」/「投影文件无 marker 区间（可能被移除）」 |
| 坏 YAML、未解析的模板 id、`expose_as_command` 越界 | ConfigError，退出码 2 | 对应条目 `level: error` + `code: 2`，聚合 `exitCode: 2` |
| 目标目录不可写 | 退出码 4（dry-run 不写盘，通常不触发） | `level: error` + `code: 4`，聚合 `exitCode: 4` |

### `doctor --json` 的结构

```json
{
  "results": [
    {
      "section": "consistency",
      "level": "warn",
      "item": "projection-hash/claude",
      "detail": "投影可能过期或被修改（SoT 在上次 sync 后已变更）: /repo/CLAUDE.md",
      "hint": "执行 aforge sync 更新投影"
    }
  ],
  "exitCode": 0
}
```

- `section`：`config` / `paths` / `consistency` / `environment`；
- `level`：`ok` / `warn` / `error`；
- `item`：检查项标识，投影一致性项恒为 `projection-hash/<targetId>`（`sync-meta` 里没有任何 target 记录时退化成单条 `projection-hash`）；
- `detail`：详情，可含 `\n`，路径一律绝对路径；
- `code`：**仅 error 级有**，表示该条问题的退出码归属（2 配置 / 3 冲突 / 4 权限）；
- `hint`：修复建议，error 与部分 warn 带。

顶层 `exitCode` 的聚合规则：只有 **error** 级参与（Permission 4 > Conflict 3 > 其它取最大），**warn 与 ok 一律算 0**。所以 `aforge doctor` 在有漂移时进程退出码是 `0`——脚本只看退出码会漏判，必须按 `results` 判。

## 退出码 → CI 排障

以 `src/core/errors.ts` 与 [Spec §6.1](../AgentForge-Spec.md#61-退出码) 为准；下表是这些码在流水线里最常见的成因。

| 码 | CI 场景下最可能的原因 | 处置 |
|----|----------------------|------|
| 1 | 通用错误（含部分投影失败后已完整回滚） | 看命令输出的 target 状态表定位失败项 |
| 2 | `aforge learn` 撞上 `CI` 守卫；`init -i` 在非 TTY 下跑；SoT 未初始化；坏 YAML；未解析的模板 id | 前两条改命令；后三条是仓库内容问题，本地 `aforge doctor` 能复现 |
| 3 | 投影 marker 区间被手改（`sync` / `sync --dry-run` 的预检查）；`.sync.lock` 被另一个 aforge 进程持有 | 前者本地 `aforge sync --force` 覆盖后提交；后者把并行的 aforge 步骤改成串行 |
| 4 | 目标目录不可写（容器里 `$HOME` 只读、投影落点在挂载卷外） | 检查 runner 的目录权限；user scope 投影确认 `AGF_HOME` / `HOME` 指向可写位置 |
| 5 | `AGF_OFFLINE=1` 下跑了 `source add git` / `source update` | 去掉 `AGF_OFFLINE`，或改用 `source add local` / 已缓存内容 |
| 6 | `sync` 失败且回滚**未能**恢复全部已写文件，备份留在 `<sotRoot>\.agf-backup-failed-<时间戳>\` | 磁盘上有半新半旧的文件，**停止后续自动化步骤**，人工核对备份 |
| 130 | 进程收到 SIGINT / SIGTERM（job 被取消 / 超时） | 进行中的 sync 事务已同步回滚，重跑即可 |

## 串行约束

`.sync.lock` 是**目录锁，不等待**：撞锁直接 ConflictError(3) 退出（Spec §10 并发安全，实现在 `src/core/project/sync-lock.ts`）。同一个 job 里不要并行跑多个 aforge 命令，多个 job 操作同一 SoT 也要靠 `concurrency` 排队。

取这把锁的不只有 `sync`：`init`、`promote`、`skill add` / `skill remove`、`mcp add` / `mcp remove`、`template enable` / `template disable`、`bundle import` 都在同一把锁内执行（`learn` 在 `auto_promote: true` 时连带 promote，也会取锁）。`source add` / `source update` 暂未纳入锁保护（Spec §10），并发跑它们的行为未定义。只有 `sync --dry-run` 与 `doctor` 不取锁——这也是漂移门禁适合放在 CI 的另一个原因。

## 环境变量

CI 场景相关的几个（完整表见 [命令速查](commands.md#环境变量)）：

| 变量 | CI 里的用法 |
|------|-------------|
| `CI` | 判定规则见上；runner 一般已注入 `CI=true`，自建环境需自己传 |
| `AGF_HOME` | 覆盖用户级 SoT 根。容器里 `HOME` 不可写、或想把 SoT 放进缓存目录时用它（不支持 UNC 路径） |
| `AGF_OFFLINE` | 严格等于 `1` 才生效。想让流水线在意外触网时立刻失败而不是挂住，就设上 |
| `AGF_SCOPE` | 强制 scope。漂移门禁要的是 `project`；非法值降级为未设置 |
| `AGF_LINE_ENDING` | 覆盖投影换行风格。**门禁里不要动它**：改了会让投影文件与提交进仓库的那份不一致 |
| `PI_CODING_AGENT_DIR` | 覆盖 pi 的 agent 目录（user scope 落点整体跟随）；project scope 的门禁用不到 |
| `FORCE_COLOR` | 想在 CI 日志里保留颜色时设置（`--json` 输出不受影响） |

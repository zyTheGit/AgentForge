# AgentForge MVP 验收清单（Spec §11.2，13 条）

验收环境：Windows（用户主环境）+ Node 22（fnm 管理）+ 本机存在 fnm 1.39.0 与 uv 0.11.3。
执行方式：`npm test`（vitest 全量，含进程内真实临时目录 + 子进程端到端两层）。
最近一次全量结果：**758 passed / 4 skipped（48+1 测试文件）**，`tsc --noEmit` 零错误。

| # | 验收条目（Spec §11.2 原文摘要） | 状态 | 证据（测试文件 → 用例） |
|---|--------------------------------|------|------------------------|
| 1 | `init -i` 在存在 fnm、uv 的环境生成正确 habits，投影含对应约定（变量渲染，非内置写死） | ✅ | `tests/e2e/acceptance.spec.ts` →「探测快照含 fnm/uv；edit 分支确认为声明后 sync 渲染；改声明再 sync 输出跟随（非写死）」（改声明为 volta/conda 后投影跟随变化，证明变量渲染）；交互五步流程：`tests/integration/init-interactive-import.spec.ts`（fake prompt 全覆盖）；探测：`tests/integration/detect.spec.ts` |
| 2 | 修改 `custom\*.md` 后 sync，启用的 target 均更新且 marker 外保留 | ✅ | `tests/integration/sync-multi.spec.ts` →「custom/*.md 修改再 sync：四 target 的 marker 区间均更新、marker 外保留（§11.2.2）」 |
| 3 | learn → promote → sync 后新规则出现在投影中 | ✅ | `tests/integration/learn-promote-sync.spec.ts` →「§11.2.3 全流程：promote → custom/<id>.md 落地…sync 后 CLAUDE.md/AGENTS.md 出现 learning 内容」+ 子进程「learn --file -（stdin）→ promote → sync」 |
| 4 | doctor 在脏投影时发现 hash 不一致；只读目录返回退出码 4 | ✅ | `tests/integration/marker-conflict.spec.ts` →「脏投影 doctor → projection-hash warn」；只读：`tests/unit/doctor-checks.spec.ts` →「目标目录不可写（EACCES）→ writable error(4)，exitCode 4」+ marker-conflict.spec.ts POSIX chmod 0555 真实权限用例（Windows 跳过、POSIX 执行） |
| 5 | 断网下仅用 base/default + 本地 habits 可走通 init/sync | ✅ | `tests/e2e/acceptance.spec.ts` →「离线环境（AGF_OFFLINE=1）init + sync 子进程端到端退出码 0，投影落地」 |
| 6 | skill add 落地为实体文件 copy，非 symlink | ✅ | `tests/integration/learn-promote-sync.spec.ts` →「skill add 实体 copy 落地 SoT skills/（非 symlink），skills.always → sync 投影 .claude/skills/」+ 子进程「source add local + skill add：SoT skills/ 落地实体文件（§11.2.6）」 |
| 7 | `AGF_OFFLINE=1` 时 source update 失败；已有内容仍可 sync | ✅ | `tests/integration/learn-promote-sync.spec.ts` →「AGF_OFFLINE=1 → source add git → 退出码 5（§11.2.7）」；`tests/unit/sources/manager.spec.ts` → OfflineError(5) 两用例；「已有内容仍可 sync」由 #5 离线 sync 走通佐证 |
| 8 | 用户级和项目级 SoT 并存时合并符合 §4.2 | ✅ | `tests/e2e/acceptance.spec.ts` →「custom 同名 project 覆盖 user；user 独有保留；habits overlay：project 未设字段由 user 补」；合并语义逐字段：`tests/unit/config-merge.spec.ts`（§4.2 两示例逐字断言 + strategy×arrays 全组合） |
| 9 | marker 区间手动修改后 sync 返回退出码 3 并提示确认 | ✅ | `tests/integration/marker-conflict.spec.ts` →「区间内手动修改 → ConflictError(3)，文件逐字节未被修改」+ 子进程「手改区间 → sync 退出码 3（§11.2.9）→ --force 退出码 0 覆盖」 |
| 10 | 包含中文和空格的路径下完成 init → sync 全流程 | ✅ | `tests/integration/sync.spec.ts` →「中文+空格目录全流程：init → sync → CLAUDE.md 产出（§11.2.10）」；此外全部集成/e2e 测试的 mkdtemp 前缀均含中文与空格（每次运行天然回归） |
| 11 | 多个 template 启用时合并输出符合 §5.2 优先级 | ✅ | `tests/e2e/acceptance.spec.ts` →「custom → tpl-a → tpl-b → base/default 顺序正确，模板变量渲染生效」；装配层：`tests/unit/generate/composer.spec.ts` →「§5.2 四层优先级」 |
| 12 | sync 任一 target 失败时所有 target 回滚到 sync 前状态 | ✅ | `tests/integration/sync-multi.spec.ts` →「事务回滚（§7.3-6 / §11.2.12）」三用例（EPERM 注入 / 全新目录新建文件删除 / 只读真实 EACCES）；引擎层：`tests/unit/project/engine-transaction.spec.ts` →「syncOnce — 事务回滚」四用例 |
| 13 | `aforge import` 从 AGENTS.md 导入工具链声明映射到 habits detected 字段 | ✅ | `tests/e2e/acceptance.spec.ts` →「AGENTS.md 导入 → detected.import 映射 → 提升声明 → sync 投影（全程子进程）」；命令层全套：`tests/integration/init-interactive-import.spec.ts`（映射/marker 区间剥除/重复导入覆盖/退出码 2/不自动 sync） |

## M9 补充验证（打包与交互基建）

| 项 | 状态 | 证据 |
|----|------|------|
| 双轨构建产物全命令冒烟 | ✅ 手动验证 | `npm run build:node` → `dist/aforge.js` 与 `npm run build:bun` → `dist/aforge.exe`：`--version` / `init --scope project` / `import AGENTS.md` / `sync` / `status` / `doctor` / `detect` 全部退出码 0（隔离 USERPROFILE 的临时目录中验证） |
| clack 动态 import 在两产物中可用 | ✅ | 两产物均内联 `@clack/prompts` 代码（`isCancel` 特征检索确认）；esbuild bundle 与 `bun build --compile` 均内联动态 import；非 TTY 防护（`init -i` → exit 2）在两产物中实测通过 |
| `init -i` 非 TTY 防护（CI/管道） | ✅ 自动化 | `tests/integration/init-interactive-import.spec.ts` →「非 TTY 环境（CI / 管道）→ ConfigError(2)，hint 引导非交互参数」；`tests/unit/prompt.spec.ts` → assertTty 8 用例 |

## 无法自动化、需人工确认的项

| 项 | 说明 | 已有替代证据 |
|----|------|--------------|
| `init -i` 真实 TTY 下的 clack 视觉渲染 | 自动化测试无法提供真实 TTY；视觉表现（光标/高亮/取消流程）需人工在终端执行 `aforge init -i` 确认 | 交互逻辑由 fake prompt 五步全覆盖（含 edit/redetect/取消分支）；clack API 封装有单测；产物内联验证完成 |

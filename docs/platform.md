# 平台注意事项与已知限制

## Windows

- **路径**：统一使用绝对路径输出；用户级 SoT 默认在 `%USERPROFILE%\.agentforge`，项目级在 `<项目根>\.agentforge`。含中文与空格的路径已受测试覆盖，可放心使用。
- **换行**：投影文件默认 LF（可通过 `profile.yaml` 的 `projection.line_ending: crlf` 修改）；SoT 内部素材统一 LF，换行差异由投影层吸收，不会造成虚假 diff。
- **离线**：无网络环境完全可用（init/sync/template/skill 等纯本地操作）。git 源的 `source update` 需要网络，离线时明确报错（退出码 5）。也可设 `AGF_OFFLINE=1` 显式声明离线意图，让需要网络的操作尽早失败。
- **权限**：**无需 Administrator**。全部文件读写都在你的用户目录与项目目录内；写失败时给出可操作的修复提示（退出码 4）。
- **控制台编码与颜色**：人类可读输出按终端能力分档，**两个维度各自独立判定**：
  - *符号*：确认为 UTF-8 宿主（Windows Terminal / VS Code 终端 / JetBrains / ConEmu-Cmder 等）时用 `✔ ✖ ─ ▸`；`cmd.exe`、PowerShell 5 的默认 GBK 代码页（`chcp 936`）以及**任何非 TTY（管道 / 重定向 / CI）**自动退回纯 ASCII（`[OK  ]` / `== 段落 ==`），因此重定向到文件的输出恒为 ASCII、不会乱码。
  - *颜色*：默认只在 TTY 下开启；`NO_COLOR` 关闭（优先级最高）、`FORCE_COLOR` 强制开启（便于 `| less -R` 与 CI 日志）、`TERM=dumb` 关闭。此外所有命令都接受位置无关的 `--no-color` / `--color`。
  - `--json` 输出不经过呈现层，恒为无色纯 ASCII，逐字节稳定。
- **交互 UI**：`init` 的交互流程需要真实终端（TTY），非 TTY 下自动退回静默默认值（等价 `init --yes`）。
- **OneDrive**：`AGF_HOME` 或项目目录落在 OneDrive 下时 `aforge doctor` 会 warn（文件锁 / 占位符状态可能导致投影写入失败）。

## macOS / Linux

见 [安装与构建](install.md#macos--linux-旁注)。

## 已知限制

- **并发安全**：多进程并发执行 `aforge sync` 或 `aforge source add` 等行为未定义。命令内部持 `.sync.lock`（非等待），撞锁直接退出码 3。建议避免并发操作同一 SoT 目录（`.agentforge/`）；如需自动化调度，请确保串行执行。
- **Symlink 支持**：`skills/` 目录恒使用实体拷贝，不使用 symlink。`profile.skills.copy_mode` 虽然接受 `symlink`，但该值**恒被忽略且不予实现**（理由见 [Spec §4.2](../AgentForge-Spec.md#42-profileyaml)：与 prune 判据冲突、Windows 默认无创建权限、四家客户端读取行为未实测）——声明 `symlink` 时 `aforge doctor` 会告警提示「当前恒为实体 copy」，投影结果不受影响；`skills/` 下已存在的断开 symlink 也会被 doctor 检出。
- **`learning.auto_capture: hook`**：MVP 未实现任何 target 侧会话钩子，行为等同 `off`，`doctor` 统一 warn。
- **`skills.on_demand`**：MVP 只登记不物化——声明的 skill 名不会被 `sync` 物化或投影，仅由 `status` / `doctor` 列出（按需装载属 Phase 2）。
- **`skills.expose_as_command`（§8.8 Commands 投影）**：已实现，含命名空间（条目写 `ns/name`）与 `$1..$9`（`SKILL.md` frontmatter 的 `command-body`）。限制在落点：pi / codex 的命令目录平铺，带命名空间的命令降级成 `ns-name.md`，`doctor` 报 `commands/namespace-flattened` warn；codex 的 **project scope 不产出**命令薄壳（其 `prompts/` 只读 user 级），`sync` 会打一条 `[codex] commands skipped: ...`，`doctor` 报 `commands/codex-project-unsupported` warn。详见 [技能](skills.md#额外投影成命令expose_as_command)。
- **技能附属文件**：会拷进 SoT，但只有 `SKILL.md` 正文参与投影。

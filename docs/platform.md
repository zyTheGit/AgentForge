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
- **会话钩子里的 `aforge`（`learning.auto_capture: hook`）**：钩子文件写的是**裸命令** `aforge learn --print-protocol`，由 codex 起进程时按 `PATH` 解析——刻意不写绝对路径，产物才能跨机器逐字节一致（见 [learning](learning.md#auto_capture-hook会话钩子投递协议)）。因此：
  - `aforge` 必须在**启动 agent 的那个 shell** 的 `PATH` 里。npm 全局安装在 Windows 上落 `%APPDATA%\npm\aforge.cmd`；如果你用 fnm / nvm 之类的版本管理器，切换 Node 版本会换掉全局 bin 目录，钩子可能突然找不到命令；
  - 找不到时钩子静默失败（非零退出被 codex 当作"该钩子没产出上下文"），会话照常继续，只是协议没注入。想确认，在同一个 shell 里跑一次 `aforge learn --print-protocol`，能打印出协议正文即为正常；
  - WSL 与 Windows 是两套 `PATH`：在 WSL 侧 sync 出来的钩子要求 WSL 侧装有 `aforge`，反之亦然。跨边界共享 SoT 时这条会咬人（另见下面的 WSL 互通）。


## macOS / Linux

见 [安装与构建](install.md#macos--linux-旁注)。

## WSL 互通

**推荐用法：SoT 与项目留在同一侧，不要跨 Windows / WSL 边界共享。** 两侧各跑一次 `aforge init`，各自管自己那一侧的项目；跨边界共享的收益（少维护一份 SoT）远小于下面几条的代价。

> **本节的实测环境**：Windows 11（build 26200，`LongPathsEnabled=0`）+ WSL2 Ubuntu（内核 `6.6.114.1-microsoft-standard-WSL2`）。`/proc/mounts` 里 `/mnt/c` 的形态是
> `C:\ /mnt/c 9p rw,noatime,aname=drvfs;path=C:\;uid=1000;gid=1000;symlinkroot=/mnt/,cache=5,access=client,msize=65536,trans=fd`——**没有 `metadata` 选项**（这是 WSL2 的默认）。Windows 侧 `COMPUTERNAME=AJIU`、`USERNAME=hpee2`；WSL 侧 `hostname` 为 `ajiu`、`USER=hpee2`（`COMPUTERNAME` / `USERNAME` / `HOSTNAME` 都没有导出给子进程）。带 `metadata` 挂载、或计算机名本身是大写的机器，结论可能不同——下面每条都写了判据，可自行复测。

### AgentForge 不检测 WSL

- 环境快照只读这几个变量：`AGF_HOME` / `AGF_SCOPE` / `AGF_OFFLINE` / `AGF_LINE_ENDING` / `CI` / `CODEX_HOME` / `PI_CODING_AGENT_DIR`，加上家目录解析用的 `USERPROFILE` / `HOME`（`src/core/env.ts:93`）。**没有** `WSL_DISTRO_NAME` / `WSL_INTEROP` / `/proc/version` 之类判据；平台上下文只有 `win32` / `darwin` / `linux` 三值（`src/core/paths.ts:16`）。因此 **WSL 内的 aforge 就是一个普通 Linux 进程**，行为与原生 Linux 完全一致，没有任何 WSL 专属分支。
- 唯一一处**已经**针对 WSL 互操作做过的处理：家目录解析按平台决定优先级——win32 上 `USERPROFILE` 优先，类 Unix 上 `HOME` 优先（`src/core/env.ts:75`）。理由就写在那段注释里：WSL 互操作会把 Windows 侧的 `USERPROFILE`（`C:\Users\x`）带进 Linux 进程，若固定 `USERPROFILE ?? HOME`，WSL 里的用户级 SoT 会落到一个不存在的盘符路径下。所以 WSL 里 SoT 稳定落在 `$HOME/.agentforge`。

### SoT 放置策略

- **Windows 侧不能把 SoT 放进 WSL 文件系统。** `\\wsl$\<distro>\...` 与 `\\wsl.localhost\<distro>\...` 都是 UNC 形态；`AGF_HOME` 以 `\\` 或 `//` 开头时，win32 上直接 `GenericError` 退出码 1（`src/core/paths.ts:120`，判据就是这两个前缀）。这条属于「不予实现」，见 [路线图](roadmap.md#不予实现)。
- 反方向（WSL 侧把 SoT 放在 `/mnt/c/...`）不会被拒：UNC 判据只在 win32 分支生效，posix 上 `//foo` 是合法绝对路径（`src/core/paths.ts:121` 的注释说明了为什么不能在 posix 上拦）。技术上可行，但要一并接受下面「锁与原子写」「大小写」两节的代价。AgentForge 依赖的**文件系统原语**已在 `/mnt/c` 上逐条实测通过（非递归 `mkdir` 的 `EEXIST`、同目录 rename、深路径读写，见下面两节），但**「WSL 侧跑一轮完整 `aforge sync`」这件事本身仍未实测**——本次验证用的发行版里没有 node / bun 运行时，装一个属于改动机器环境，没做。所以这条只能说「前提条件都成立」，不能说「整体可用」。
- `aforge doctor` 的 `user-sot-root` 条目会把 UNC `AGF_HOME` 报成 error（`src/core/doctor/check-config.ts:27` 调 `resolveUserSoT`）——看到这条就是撞上了上面那条拒绝。

### user scope 是两份，不会自动合并

- 四个 target 的 user scope 落点全部从 `env.userProfile` 拼出：opencode `<home>/.config/opencode`、codex `<home>/.codex`、claude `<home>/.claude`、pi `<home>/.pi/agent`（`src/core/paths.ts:98`；projector 侧同构，见 `src/core/project/projectors/opencode.ts:67`、`codex.ts:58`、`claude.ts:54`、`pi.ts:76`）。Windows 上 `<home>` 是 `C:\Users\x`，WSL 上是 `/home/x`——**这是两套完全独立的 user scope**，一侧 `aforge sync` 不会影响另一侧的客户端配置。想两边都生效就两边都 sync。
- **没有 `~` 展开。** `CODEX_HOME` / `PI_CODING_AGENT_DIR` 的取值直接进 `path.resolve()`（`src/core/paths.ts:103` / `106`，projector 侧 `codex.ts:61`、`pi.ts:79`），全仓无任何 tilde 展开逻辑。写成 `~/.codex` 会得到一个字面名为 `~` 的目录，而不是家目录下的 `.codex`。
- 更隐蔽的一种：Windows 侧的 shell 若继承了 WSL 风格的 `CODEX_HOME=/home/x/.codex`，`path.win32.resolve` 会按当前盘符把它绝对化成 `C:\home\x\.codex`——**不报错、静默落错位置**。跨环境切换后先跑 `aforge doctor` 看 `path/<target>` 条目（恒为 ok 的信息项，直接打印两个 scope 的实际落点，`src/core/doctor/check-paths.ts:61`）核对落点。
- 这两个变量**不过** UNC 校验：`validatePath` 只在 `resolveUserSoT` 里被调用一次（`src/core/paths.ts:78`），`CODEX_HOME` / `PI_CODING_AGENT_DIR` 走的是裸 `api.resolve()`。也就是说 `AGF_HOME` 指向 `\\wsl.localhost\...` 被拒，但 `CODEX_HOME` 指向同一位置不会被拒。这是实现上的不对称，别依赖它。**实测**（Windows 侧 node 对 `\\wsl.localhost\Ubuntu\tmp\...`）：`mkdir -p`、非递归 `mkdir`（第二次如期 `EEXIST`）、`writeFile` / `readFile`、**同目录 rename**（`atomicWrite` 的落地方式）全部成功；`path.win32.resolve` 保留 `\\` 前缀不变形；长路径的 `\\?\UNC\wsl.localhost\...` 形式可写（`longPathAware` 的 UNC 分支产出的正是这个形式，`src/core/paths.ts:151`），而把 `\\?\` 直接拼在 `\\` 前的朴素写法则 `ENOENT`。唯一不成立的是权限位：`chmod 0o600` 后回读仍是 `666`（同下面 `/mnt/c` 那条，SMB/9p 层不承载 Unix mode）。所以「UNC 落点写不进去」这个担心不成立，真正的代价是不可靠的权限语义 + 网络重定向器的延迟。

### 换行符与 marker hash

- 仓库侧 `.gitattributes:2` 是 `* text=auto eol=lf`，两侧 checkout 都得到 LF，git 层不制造差异。
- **CRLF/LF 差异不会让 `doctor` 报 hash 漂移。** marker 区间指纹先归一化成 LF 再算 sha256（`src/infra/fsutil.ts:57`），`markerSectionHash`（`src/core/markers.ts:181`）与 doctor 的三方比对（`src/core/doctor/check-projection-hash.ts:70`）用的都是它。换行风格被这层规范化整体吸收。
- 真正会被换行影响的是**落盘形态的逐字节比对**：`applyItem` 的幂等快速路径拿现有文件与 `normalizeLineEnding(merged, lineEnding)` 精确比较（`src/core/project/writer.ts:210`）。若一侧的编辑器把投影文件存成 CRLF 而 `profile.projection.line_ending` 是 `lf`，每次 `sync` 都会重写该文件（计入 written 而非 skipped），内容语义不变但 diff 与写次数变多。
- 结论：两侧的 `projection.line_ending` 保持一致（默认 `lf` 即可），不要一侧 `lf` 一侧 `crlf`。

### 锁与原子写

- `.sync.lock` 是**目录锁**，互斥原语是非递归 `mkdir` 的 `EEXIST`（`src/infra/real-host.ts:97`、`src/core/project/sync-lock.ts:231`）。**实测成立**：在 `/mnt/c` 的同一目录下，Windows 侧（node `fs.mkdirSync`，与 `Host.mkdirExclusive` 同一 syscall）与 WSL 侧（coreutils `mkdir`）按同一墙钟时刻起跑、各自以不同随机顺序抢同一批 20000 个目录名，结果是 Windows 赢 19079、WSL 赢 921，**合计正好 20000、双方赢下的名字集合交集为空**，磁盘上也正好 20000 个目录。真并发是确认过的（单侧独跑 20000 次约 0.2s，本轮 Windows 侧耗时 9.5s，被对侧压满）。单侧重复 `mkdir` 同一目录同样如期报 `File exists`。
- 抢占陈旧锁的判据是「心跳停摆 > 5 分钟 **且** 持有者进程已不存活」，其中 pid 判活只在「同机器 + 同用户」时才采信（`src/core/project/sync-lock.ts:239`；`machineIdOf` / `userIdOf` 见同文件 `104` / `109`，`isProcessAlive` 见 `119`）。**判据是严格字符串相等**（`holder.machine === machineIdOf(host)`），而 `machineIdOf` 取 `COMPUTERNAME → HOSTNAME → os.hostname()`、`userIdOf` 取 `USERNAME → USER → os.userInfo().username`。实测这台机器上两侧的取值是：Windows `AJIU` / `hpee2`，WSL `ajiu` / `hpee2`（WSL 里 `COMPUTERNAME`、`USERNAME`、`HOSTNAME` 都不在子进程环境里，落到 `os.hostname()`）。**结论：机器名的大小写决定一切**——Windows 恒把 `COMPUTERNAME` 报成全大写，WSL 的 `hostname` 保留原始大小写。计算机名本身是小写/混合大小写时（本机就是），`sameHost` 跨边界为 **false**，pid 探针不被采信，落回心跳判据（30 秒刷新 / 5 分钟阈值，`sync-lock.ts:57` 与 `31`）；计算机名本身全大写时两侧字符串相同，`sameHost` 为 **true**，此时 pid 探针会拿本侧 pid 空间去判对侧进程，结论不可信——极端情况下会把对侧仍在写的锁判成「进程已消失」而抢占（前提是心跳同时已停摆超 5 分钟）。
- **「跨文件系统边界 rename 会失败」在这里不成立**：`atomicWrite` 的临时文件与目标**同目录**（`src/infra/fsutil.ts:100`），rename 永远发生在同一文件系统内。实测 WSL 侧在 `/mnt/c` 上做同目录 `mv` 成功。`/mnt/c` 场景下真实的风险是另一侧进程占用目标文件，rename 拿到 `EPERM` / `EACCES` → `PermissionError` 退出码 4（`src/infra/fsutil.ts:131`）。
- `copyMode` 在 posix 上把目标原有权限位复制到临时文件（`src/infra/real-host.ts:71`，win32 上是 no-op）。**实测：默认（不带 `metadata`）挂载下 `chmod` 是无效操作**——`/mnt/c` 上新建文件恒为 `777`，`chmod 600` 退出码 0 但回读仍是 `777`（同一发行版 ext4 `/tmp` 上的对照组正确变成 `600`）。即 posix 分支的 `copyMode` 在 `/mnt/c` 上等价于 no-op：不报错、不阻断写入（失败本来也是 best-effort 吞掉，`src/infra/fsutil.ts:122`），只是「保留原权限」这件事不会发生。带 `metadata` 挂载选项时行为不同（本次未测）。
- 结论：互斥原语本身跨边界成立（上面那轮 20000 次对抗实测），但仍**不建议**两侧同时对同一份 SoT 跑 `sync`——理由变成了后两条：`sameHost` 的取值取决于计算机名大小写这种偶然因素，以及大小写不敏感带来的「同一项目两个根 → 两把锁」。另见下方 [已知限制](#已知限制) 的并发安全条目。

### 大小写与路径长度

- posix 分支的路径比较是**大小写敏感**的：`samePath` 只在 win32 折叠大小写（`src/core/paths.ts:130`），`isWithinAnyRoot` 的 fold 同理（`src/core/paths.ts:236`）。而 `/mnt/c` **实测确认大小写不敏感**：WSL 侧建出 `.../CaseProbe` 后，`[ -d .../caseprobe ]` 与 `[ -d .../CASEPROBE ]` 都命中，再 `mkdir .../caseprobe` 报 `File exists`（即文件系统只认一个目录，但任意大小写写法都能访问到它）。于是 WSL 侧分别用 `/mnt/c/Zy/proj` 和 `/mnt/c/zy/proj` 访问同一个项目时，AgentForge 会当成两个不同的根：影响面是锁根推导（`resolveLockRoots`，`src/core/project/sync-lock.ts:427`）与落盘 journal 的归属判定——两个「根」各自建自己的 `.sync.lock`，互斥就失效了。规避办法是固定路径的大小写写法（例如始终用 `cd -P` 后的形态，或在脚本里写死一种）。
- Windows 长路径 `\\?\` 前缀只在 win32 上添加（`src/core/paths.ts:142`）。**实测：WSL 侧不受 260 字符限制**——在 `/mnt/c` 下逐级建到 40 层、目录路径 905 字符仍成功，在 914 字符处写文件并读回正常。反向读也没问题：Windows 侧 node 走普通路径（无 `\\?\`）就能 `readdir` / `stat` / 读到那个 910 字符的文件，加 `\\?\` 前缀同样可以——注意这台机器的 `LongPathsEnabled=0`，能成的原因是 libuv 自己会把超长绝对路径转成 `\\?\` 形式，**不能**据此推断「Win32 API 裸长路径可用」。`longPathAware` 因此是一层显式冗余保护，而不是唯一屏障。

### doctor 在跨环境下的读法

- `path/<target>`：恒为 ok 的信息项，打印 project 与 user 两个 scope 的实际落点（`src/core/doctor/check-paths.ts:61`）。跨环境时**先看这条**确认到底写到哪。
- `writable`：会真的 mkdirp + 写探针文件 + 删除（`src/core/doctor/check-writable.ts:33`）。跨边界目录（`/mnt/c` 上被 Windows 进程占用、或 UNC 位置）探测失败会报 error(4)——这**不是误报**，`sync` 在同一位置同样会失败。
- `onedrive`：判据只看 `env.userProfile`，不看项目目录、也不看 `AGF_HOME`（`src/core/doctor/check-environment.ts:70` → `src/core/paths.ts:193`），而 `OneDrive` 环境变量默认不会通过 `WSLENV` 传进 WSL。因此在 WSL 侧对 `/mnt/c/Users/x/OneDrive/...` 下的项目**不会**告警——别把这条 ok 当成「不在 OneDrive 上」的证明。
- `residual/lock-live` / `residual/lock-stale`：新鲜度判据与 sync 同源（`src/core/project/sync-lock.ts:46`），但元数据里的 `pid` / `machine` / `user` 是持有者那一侧的口径，跨环境共享 SoT 时不可直接解读。

## 已知限制

本节列的是**字段级的行为边界**；分阶段的完成度与决策见 [路线图与实现状态](roadmap.md)。

- **并发安全**：多进程并发执行 `aforge sync` 或 `aforge source add` 等行为未定义。命令内部持 `.sync.lock`（非等待），撞锁直接退出码 3。建议避免并发操作同一 SoT 目录（`.agentforge/`）；如需自动化调度，请确保串行执行。Windows 侧与 WSL 侧同时操作同一份 SoT 是这条限制的一个具体形态，见 [WSL 互通](#wsl-互通)。
- **Symlink 支持**：`skills/` 目录恒使用实体拷贝，不使用 symlink。`profile.skills.copy_mode` 虽然接受 `symlink`，但该值**恒被忽略且不予实现**（理由见 [Spec §4.2](../AgentForge-Spec.md#42-profileyaml)：与 prune 判据冲突、Windows 默认无创建权限、四家客户端读取行为未实测）——声明 `symlink` 时 `aforge doctor` 会告警提示「当前恒为实体 copy」，投影结果不受影响；`skills/` 下已存在的断开 symlink 也会被 doctor 检出。
- **`learning.auto_capture: hook`**：只有 **codex** 有可声明式写入的会话钩子落点（`hooks.json`）；claude / opencode / pi 在这一档行为等同 `off`，`sync` 每家打一行降级提示、`doctor` 报一条 `learning-auto-capture-hook` warn。支持矩阵与理由见 [learning](learning.md#支持矩阵)。
- **`skills.on_demand`**：MVP 只登记不物化——声明的 skill 名不会被 `sync` 物化或投影，仅由 `status` / `doctor` 列出（按需装载属 Phase 2）。
- **`skills.expose_as_command`（§8.8 Commands 投影）**：已实现，含命名空间（条目写 `ns/name`）与 `$1..$9`（`SKILL.md` frontmatter 的 `command-body`）。限制在落点：pi / codex 的命令目录平铺，带命名空间的命令降级成 `ns-name.md`，`doctor` 报 `commands/namespace-flattened` warn；codex 的 **project scope 不产出**命令薄壳（其 `prompts/` 只读 user 级），`sync` 会打一条 `[codex] commands skipped: ...`，`doctor` 报 `commands/codex-project-unsupported` warn。详见 [技能](skills.md#额外投影成命令expose_as_command)。
- **探测器边界（`aforge detect`）**：全程零子进程、零网络，只做 PATH 文件名匹配与配置文件存在性判断，因此拿不到任何**运行时**版本号——版本一律来自版本文件（`.node-version` / `.java-version` / `.sdkmanrc` / `global.json` 等），文件没写就没有 `version`。几处具体边界：sdkman 的 `sdk` 是 shell 函数、PATH 上没有本体，只能靠 `.sdkmanrc` 或 `SDKMAN_DIR` 判出；`dotnet` 没有第三方版本管理器生态，manager 只有 `system` / `none`；`monorepo` 多工具共存时只报优先级首位（`nx` > `turbo` > `lerna` > `rush` > `pnpm-workspace`）；`ci` 纯看文件/目录，`.github/workflows/` 需含至少一个 `.yml` / `.yaml` 才算命中。字段清单见 [habits.yaml 字段参考](habits.md#detected-快照结构)。
- **技能附属文件**：会拷进 SoT，但只有 `SKILL.md` 正文参与投影。

# AgentForge

用一份事实源（SoT）统一管理你的 AI 编码助手规则，一键投影到 opencode / codex / claude / pi 四个目标 Agent——改一处，处处最新，且不碰你在投影文件里手写的内容。

## 是什么

你是否在 `AGENTS.md`、`CLAUDE.md` 等多个规则文件里重复维护同一套工具链约定？AgentForge 把这些收进项目（或用户级）的 `.agentforge` 目录：

- **habits.yaml**：声明你的工具链与 AI 偏好（node 用 fnm、python 用 uv、包管理器优先 pnpm……）；
- **custom/*.md**：自由格式的规则素材；
- **learnings/**：从实战经验沉淀、待确认的条目（`aforge learn`）；
- **templates/、skills/、mcp/**：可复用模板、技能与 MCP 服务器声明。

执行 `aforge sync` 后，以上内容被渲染并写入各 Agent 的原生规则文件。AgentForge 只管理文件中的 marker 区间，区间外你的手写内容原样保留。

## 安装

### 方式一：npx 直接用（推荐，无需克隆）

前置：Node ≥ 20.19。

```powershell
# 免安装试跑（每次拉最新版；@latest 用于绕开 npx 的本地缓存）
npx -y @zythegit/agentforge@latest --version
npx -y @zythegit/agentforge@latest init -i

# 常用则全局装，之后直接 aforge
npm i -g @zythegit/agentforge
aforge --version
```

包名是 `@zythegit/agentforge`，命令名是 `aforge`。发布产物是 esbuild 打出的单文件 bundle（依赖已内联），因此 `npx` 冷启动只下载一个文件，不再安装任何运行时依赖。

### 方式二：下载独立二进制（免 Node，兜底）

只有在目标机器装不了 Node 时才需要这条路：二进制内嵌了 bun 运行时，压缩包 36~39 MB（解包后 64~86 MB），比 npm 包大两个数量级。

从 [Releases](https://github.com/zyTheGit/AgentForge/releases) 下载对应平台的压缩包（附 `checksums.txt`，内容是**压缩包**的 sha256）：

| 平台 | 资产 |
| --- | --- |
| Windows x64 | `aforge-win32-x64.zip` |
| Linux x64 / arm64 | `aforge-linux-x64.tar.gz` / `aforge-linux-arm64.tar.gz` |
| macOS Apple Silicon / Intel | `aforge-darwin-arm64.tar.gz` / `aforge-darwin-x64.tar.gz` |

解包后重命名为 `aforge`（Windows 为 `aforge.exe`）放进 PATH 即可。

macOS 上二进制未做签名与公证，首次运行会被 Gatekeeper 拦下，需手动去掉隔离属性：

```bash
xattr -d com.apple.quarantine ./aforge
```

`aforge-linux-arm64` 在 CI 里只靠 QEMU 模拟跑过 `--version`，没有 arm64 真机验证；`aforge-darwin-x64` 既无免费 runner 也无法用容器模拟，属于「已交叉编译但完全未冒烟」。

### 方式三：从源码构建

前置：安装 [bun](https://bun.sh/) 与 [fnm](https://github.com/Schniz/fnm)（或任意 Node 版本管理器）。

```powershell
# 每个新终端先激活 Node 环境（fnm）
fnm env --shell power-shell | Out-String -Stream | Invoke-Expression
fnm use 22

git clone https://github.com/zyTheGit/AgentForge.git
cd AgentForge
npm install

npm run build:node    # 产出 dist\aforge.js（esbuild 打包压缩，需 Node ≥ 20.19）
npm run build:bun     # 产出当前平台的单文件二进制（dist\aforge-win32-x64.exe 等）
npm run build:bun:all # 交叉编译五平台（win32-x64 / linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64）
bun link              # 之后任意目录可用 aforge 命令
```

两条构建轨道功能等价、分发形态不同：二进制零依赖可直接分发，代价是体积；`aforge.js` 需要既有 Node 环境，也是 npm 包实际发布的产物。


## 快速开始（Windows PowerShell）

```powershell
# 进入你的项目
cd C:\path\to\your-project

# ① 交互式初始化：选 scope → 自动探测工具链 → 确认 → 选目标 Agent → 写入（可选立即 sync）
aforge init -i

# ② 之后每次修改 .agentforge 内的任意内容，同步到四个目标
aforge sync
```

不想交互？全部可用参数表达（CI / 脚本友好）：

```powershell
aforge init --scope project
aforge sync
```

从既有规则文件搬家？把工具链声明直接导入：

```powershell
aforge import AGENTS.md    # 或 CLAUDE.md：识别工具链关键词 → habits 建议字段 + custom 素材
```

## 命令速查（13 个）

| 命令 | 作用 |
|------|------|
| `aforge init -i` | 交互式五步初始化（scope → 探测 → 确认 → 选 target → 写入） |
| `aforge init [--scope project\|user] [--json]` | 非交互初始化（探测快照 + 骨架落盘） |
| `aforge detect [--json]` | 探测本机工具链（node/python/包管理器/shell/已有规则文件），无副作用 |
| `aforge sync [--targets a,b] [--dry-run] [--force] [--json]` | 渲染 SoT 并投影到目标 Agent |
| `aforge learn [--scope s] [--file f\|'-'] [--id id]` | 记录一条 learning（不投影） |
| `aforge promote <id> [--to user] [--yes]` | 将 learning 升级为 custom 规则或 skill |
| `aforge learnings list [--json]` / `show <id>` / `edit <id>` / `rm <id>` | 管理两层 SoT 的 learning 条目 |
| `aforge source add <path\|git-url> [--ref r] [--id id]` | 登记规则/模板/技能来源（local 或 git） |
| `aforge source list [--json]` / `remove <id>` / `update <id>` | 管理已登记来源（update 离线报错） |
| `aforge template list [--json]` / `enable <id>` / `disable <id>` | 管理规则模板 |
| `aforge skill add <name> [--from src]` / `list [--json]` / `remove <name> [--scope s]` | 安装（实体拷贝）/列出/注销技能（`remove` 只改 profile，文件保留） |
| `aforge mcp add [--scope s] [--from-json] [--json]` / `remove <name> [--scope s] [--json]` | 登记 / 移除 MCP 服务器声明（`--from-json` 从 stdin 读 JSON 声明） |
| `aforge status [--json]` | SoT 概览：scope、目标路径、最近 sync、内容计数 |
| `aforge doctor [--json]` | 体检：配置合法性、投影一致性、环境问题 |
| `aforge import <path>` | 从既有 AGENTS.md / CLAUDE.md 导入工具链声明与素材 |

`--json` 同时是 program 级全局标志：任何子命令都可写成 `aforge --json <cmd>`，输出为机器可读 JSON（路径一律绝对路径）。注意 `mcp add` 的**输入**标志叫 `--from-json`，`--json` 只表示输出契约。

## 安装 skill

`aforge skill add` 接的是**技能名**，不是 URL——URL 要先 `aforge source add` 登记成「源」，再按名安装。以装 vercel-labs/skills 里的 `find-skills` 为例：

```powershell
# ① 登记 git 源（必须显式 --ref，Spec 不跟踪浮动分支）
aforge source add https://github.com/vercel-labs/skills --ref main
#   clone 到 %USERPROFILE%\.agentforge\store\skills；id 由 basename 派生为 "skills"
#   想自定义 id 加 --id vercel-skills

# ② 看源里有哪些技能可装（status=available 的条目）
aforge skill list

# ③ 按名安装：实体拷贝到 SoT 的 skills\find-skills\
aforge skill add find-skills --from skills
```

`--from` 可省略（按登记顺序在所有启用的源中找首个含该技能的源），也可直接传路径而完全跳过 `source add`——传源根目录（其下有 `skills\<name>\`）或直接传含 `SKILL.md` 的技能目录本身：

```powershell
aforge skill add find-skills --from D:\clones\vercel-labs-skills   # 源根
aforge skill add my-skill --from .\drafts\my-skill                 # 技能目录本身
```

`skill add` 除了把文件拷进 `.agentforge\skills\`，还会把技能名登记进**同一层** `profile.yaml` 的 `skills.always`（幂等，重复 add 不会写重名），所以装完直接 `sync` 就能投影：

```yaml
# .agentforge\profile.yaml（skill add 自动维护）
skills:
  copy_mode: copy
  always:
    - find-skills
```

```powershell
aforge sync
```

注意：凡是会写 `profile.yaml` 的命令（`skill add`、`skill remove`、`mcp add`、`mcp remove`、`template enable`）都是整份重新序列化，YAML 注释、空行和行内数组写法（`targets: [claude]`）会丢失，键顺序变成程序内部顺序——手写过的 `profile.yaml` 被这些命令改过后格式会变。

只想拷文件、自己手工编排 `profile.yaml` 的话加 `--no-register`：

```powershell
aforge skill add find-skills --no-register
```

投影落点（project scope，`SKILL.md` 正文）：

- opencode → `.opencode\skills\<name>\SKILL.md`
- codex → `.agents\skills\<name>\SKILL.md`
- claude → `.claude\skills\<name>\SKILL.md`
- pi → `.pi\skills\<name>\SKILL.md`

要点：

- 源仓库布局须为 `<源根>\skills\<name>\SKILL.md`；
- 目标 `skills\<name>` 已有内容 → 退出码 3，先手删该目录再装；
- 源里的 symlink 一律跳过不跟随（防私钥等被读进 SoT），跳过项在输出的 `skipped` 里列出；
- `skills.always` 点了名却没装 → `sync` 直接报错退出码 2；
- 装到 user 层时注意 §5.3 合并语义：`merge.arrays: replace`（缺省）下 project 层自己写了 `skills.always` 就会整体覆盖 user 层那份；
- 附属文件（脚本、参考资料）会拷进 SoT，但当前只有 `SKILL.md` 正文参与投影。

不想再让某个技能被投影时用 `skill remove`——它**只**把名字从该层 `profile.yaml` 的 `skills.always` 摘掉，`skills\<name>\` 目录原样留在磁盘上：

```powershell
aforge skill remove find-skills
# skill removed: find-skills (profile only)
#   scope     : project
#   profile   : D:\proj\.agentforge\profile.yaml
#   always    : pdf-tools
#   skill dir : D:\proj\.agentforge\skills\find-skills (kept on disk)
#
# note: removed from profile.yaml only. `aforge sync` does NOT prune already
#       projected files yet - delete these by hand (project level):
#         D:\proj\.opencode\skills\find-skills\SKILL.md
#         D:\proj\.agents\skills\find-skills\SKILL.md
#         D:\proj\.claude\skills\find-skills\SKILL.md
#         D:\proj\.pi\skills\find-skills\SKILL.md
```

- **已知限制：`aforge sync` 暂不 prune 已投影产物。** 摘除只作用于 SoT，再跑一次 `sync` **不会**删掉之前投影出去的 `.claude\skills\<name>\SKILL.md`（`.opencode` / `.agents` / `.pi` 同理）——投影只写"应该有的产物"，不比对上一轮的差集。要彻底清干净，按命令输出提示手工删除那几个目录。prune 语义属**后续独立交付**，见 Spec §7.6「已知限制」；
- `--scope project|user` 指定改哪一层（缺省同 `add`：AGF_SCOPE > project 在用 > user 在用）；两层都登记了同名技能时要各删一次；
- 该层 `skills.always` 里没有这个名字 → 退出码 2（不当成幂等成功，多半是层选错了）。错误提示会说明目录是否还在盘上；如果另一层登记了同名，提示会直接给出可复制的 `--scope <另一层>`；
- 摘完 `always` 只剩空数组时那一行显示 `(none)`；注意 `merge.arrays: replace` 下空数组**仍会覆盖** user 层，要让 user 层的同名技能重新生效得手工删掉 project 层的整个 `skills.always` 键；
- 要腾空间 / 想重装，删完登记后手工删除 `skills\<name>\`（`skill add` 遇到已存在且非空的目录会报退出码 3）。

## 登记 MCP 服务器

`aforge mcp add` 把声明写进目标层 `profile.yaml` 的 `mcp.servers`（同名 upsert，重复 add 即更新），`sync` 时再翻译成各 Agent 的原生 MCP 配置。

交互录入（需要真实终端）。以装 `npx -y @zythegit/jenkins-config-mcp` 为例：

```powershell
aforge mcp add
#   name      : jenkins-config
#   transport : stdio
#   command   : npx
#   args      : -y @zythegit/jenkins-config-mcp     ← 空格分隔，自动切成数组
#   env       : 留空（需要凭据时填 JENKINS_URL=...,JENKINS_TOKEN=...）
```

脚本化：从 stdin 读一个 JSON 声明（注意标志是 `--from-json`）：

```powershell
# stdio：npx 拉起的本地 server
'{"name":"jenkins-config","transport":"stdio","command":"npx","args":["-y","@zythegit/jenkins-config-mcp"]}' |
  aforge mcp add --from-json

# http：远端端点（带鉴权头）
'{"name":"ctx7","transport":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer <token>"}}' |
  aforge mcp add --from-json

# 写到用户层，让所有项目共享
'{"name":"jenkins-config","transport":"stdio","command":"npx","args":["-y","@zythegit/jenkins-config-mcp"]}' |
  aforge mcp add --from-json --scope user

aforge sync
```

必填字段：`name` + `transport`；`stdio` 必须给 `command`，`http` / `sse` 必须给 `url`，否则退出码 2。声明里带 `"enabled": false` 的 server 不投影，但保留在 `profile.yaml` 里。

不想再用某个 server 时用 `mcp remove` 把声明从该层 `mcp.servers` 里摘掉：

```powershell
aforge mcp remove jenkins-config
# mcp server removed: jenkins-config
#   transport : stdio
#   scope     : project
#   profile   : D:\proj\.agentforge\profile.yaml
#   servers   : ctx7
#
# note: removed from profile.mcp.servers only. `aforge sync` does NOT prune
#       already projected keys yet - delete the "jenkins-config" entry by
#       hand from these project-level files:
#         D:\proj\opencode.json
#         D:\proj\.mcp.json
#         D:\proj\.pi\mcp.json
```

- **已知限制：`aforge sync` 暂不 prune 已投影的 MCP 键。** 被删的 server 在 `opencode.json` / `.mcp.json` / `.pi\mcp.json` 里会**永久保留**——merge_json 遵循「未知键一律保留」（Spec §8.2），被删的键在下一轮投影里只是"没被写"而不是"要删掉"，`sync` 甚至会把这些文件报成 `unchanged, skipped`。按命令输出提示手工删掉那几个键。例外：codex 的 `.codex\config.toml` 走 marker 段整段重写，会自动跟上。prune 语义属**后续独立交付**，见 Spec §7.6「已知限制」；
- `--scope project|user` 指定改哪一层（缺省同 `add`）；`--json`（或 `aforge --json mcp remove <name>`）输出机器可读结果，含被删条目 `removed` 与该层剩余 `servers`；
- 该层没有这个名字 → 退出码 2，错误消息会列出该层现有的 server 名；如果另一层登记了同名，提示会直接给出可复制的 `--scope <另一层>`；
- 摘掉最后一条后 `servers` 一行显示 `(none)`；
- 只想临时停用而保留配置的话，别用 remove——把声明里的 `enabled` 改成 `false` 重新 `add`（同名 upsert）即可。

投影落点（project scope）：

- opencode → `opencode.json` 的 `mcp` 键（merge_json，未知键保留）
- codex → `.codex\config.toml` 的 `# BEGIN AGENTFORGE MCP` 标记段（merge_toml，段外 TOML 与注释原样保留）
- claude → `.mcp.json` 的 `mcpServers` 键（merge_json）
- pi → `.pi\mcp.json` 的 `mcpServers` 键（merge_json，**soft 项**：写失败只报 warning，不算 sync 失败、不触发回滚）。pi 本体不内建 MCP，先装适配扩展才生效：`pi install npm:pi-mcp-adapter`（见 <https://pi.dev/packages/pi-mcp-adapter>）；写 `.pi\mcp.json` 而不是根 `.mcp.json`，是为了不与 claude 的投影争用同一路径（同一次 sync 里两个 projector 写同一文件会互相覆盖）。适配器优先级：`.pi\mcp.json`（项目级）> `.mcp.json`（项目共享）> `<Pi agent dir>\mcp.json`（user 级，即 user scope 的落点）> `~\.config\mcp\mcp.json` / `~\.agents\mcp.json`——user 级 pi 配置会被任何项目的 `.mcp.json` 盖掉，别把它当兜底；user scope 目前也不认 `PI_CODING_AGENT_DIR`，置位该变量时这份投影落在 pi 不读的路径上

> 升级提示：早期版本把 pi 的 MCP 写在 `.pi\settings.json`（user 级 `~\.pi\agent\settings.json`）。现在落点是同目录的 `mcp.json`，旧文件**不会被自动迁移或删除**——确认新 `mcp.json` 生效后请手工删掉旧文件里的 `mcpServers` 键（整份文件没有你自己的 pi 设置时可直接删除）。`aforge doctor` 会把它报为 `residual/pi-legacy-mcp` warning。

以上面的 jenkins-config 为例，`sync` 后 `.mcp.json` 里会多出：

```json
{
  "mcpServers": {
    "jenkins-config": {
      "command": "npx",
      "args": ["-y", "@zythegit/jenkins-config-mcp"]
    }
  }
}
```

opencode 侧同一条声明会被译成 `{ "type": "local", "command": ["npx", "-y", "@zythegit/jenkins-config-mcp"], "enabled": true }`——各 target 的键名与形状不同，AgentForge 负责翻译，你只写一份声明。

Windows 上 `command: "npx"` 可能起不来：部分客户端不经 shell 直接 spawn，而 `npx.cmd` 不是可执行文件。启动失败就把 `command` 换成 `cmd`、`args` 前面补 `/c` 重新 add（同名 upsert，直接覆盖旧声明）：

```powershell
'{"name":"jenkins-config","transport":"stdio","command":"cmd","args":["/c","npx","-y","@zythegit/jenkins-config-mcp"]}' |
  aforge mcp add --from-json
```

`headers` / `env` 里的 token 会明文落在 `profile.yaml` 和投影出的配置文件里——项目层 SoT 通常进 git，敏感凭据建议放用户层（`--scope user`）或改用环境变量间接引用。

## 工作原理

```
                .agentforge/ (SoT)                          Agent 原生规则文件
        ┌────────────────────────────┐
        │ habits.yaml   (工具链声明) │      render        ┌─ AGENTS.md  (opencode)
        │ custom/*.md   (自由素材)   │  ─────────────►    ├─ AGENTS.md  (codex)
        │ learnings/    (经验沉淀)   │     (sync)         ├─ CLAUDE.md  (claude)
        │ templates/    (规则模板)   │                    └─ AGENTS.md  (pi)
        │ skills/  mcp/              │
        └────────────────────────────┘
```

每个投影文件中，AgentForge 只管理 marker 区间：

```markdown
<!-- BEGIN AGENTFORGE -->
（AgentForge 渲染内容——sync 时整体替换）
<!-- END AGENTFORGE -->

（marker 之外的内容属于你，sync 永不触碰）
```

- **变更检测**：sync 前对比 marker 区间指纹，发现你手改过区间内容 → 拒绝写入（退出码 3），`--force` 可覆盖；
- **事务化写入**：多 target 投影失败自动回滚已写文件；
- **两级合并**：user 层 SoT 与 project 层 SoT 按层合并（project 优先）。

## Windows 注意事项

- **路径**：统一使用绝对路径输出；用户级 SoT 默认在 `%USERPROFILE%\.agentforge`，项目级在 `<项目根>\.agentforge`。含中文与空格的路径已受测试覆盖，可放心使用。
- **换行**：投影文件默认 LF（可通过 `profile.yaml` 的 `projection.line_ending: crlf` 修改）；SoT 内部素材统一 LF，换行差异由投影层吸收，不会造成虚假 diff。
- **离线**：无网络环境完全可用（init/sync/template/skill 等纯本地操作）。git 源的 `source update` 需要网络，离线时明确报错（退出码 5）。也可设 `AGF_OFFLINE=1` 显式声明离线意图，让需要网络的操作尽早失败。
- **权限**：**无需 Administrator**。全部文件读写都在你的用户目录与项目目录内；写失败时给出可操作的修复提示（退出码 4）。
- **控制台编码**：非交互命令输出为纯 ASCII（GBK 代码页 `chcp 936` 下不乱码）；`init -i` 的交互 UI 需要真实终端（TTY）。

### 环境变量

| 变量 | 作用 |
|------|------|
| `AGF_SCOPE` | 缺省 scope（`project` / `user`） |
| `AGF_HOME` | 覆盖用户级 SoT 根目录 |
| `AGF_LINE_ENDING` | 覆盖投影换行风格（`crlf` / `lf`） |
| `AGF_OFFLINE` | 设为 `1` 声明离线模式 |

## 退出码约定

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 2 | 配置错误（未初始化、非法参数、非 TTY 环境跑交互命令等） |
| 3 | 冲突（marker 区间被手改，拒绝覆盖） |
| 4 | 权限错误（目标不可写） |
| 5 | 离线（需要网络的操作在离线模式下失败） |

## 已知限制

- **并发安全**：多进程并发执行 `aforge sync` 或 `aforge source add` 等行为未定义。建议避免并发操作同一 SoT 目录（`.agentforge/`）。如需自动化调度，请确保串行执行。
- **Symlink 支持**：`skills/` 目录恒使用实体拷贝，不使用 symlink。`profile.skills.copy_mode` 虽然接受 `symlink`，但 MVP 忽略该值（symlink 属 Phase 2）——声明 `symlink` 时 `aforge doctor` 会告警提示"当前恒为实体 copy"，投影结果不受影响；`skills/` 下已存在的断开 symlink 也会被 doctor 检出。

## macOS / Linux 旁注

- 首选装法与 Windows 一致：`npx -y @zythegit/agentforge@latest`（或 `npm i -g`）；
- 从源码构建：`fnm env --shell bash | source -`（或 zsh）后 `npm install` + `npm run build:node`；
- 用户级 SoT 在 `$HOME/.agentforge`；投影换行默认规则同 Windows（profile 可配置）；
- `npm run build:bun` 自动按当前平台选 target，`build:bun:all` 一次交叉编译五平台；
- macOS 二进制未签名未公证，见上文「方式二」的 `xattr` 说明。

## 开发

```powershell
fnm env --shell power-shell | Out-String -Stream | Invoke-Expression
fnm use 22
npm install
npm test           # 全量测试（vitest）
npm run typecheck  # tsc --noEmit
npm run build      # 双轨构建（node + bun）
```

验收清单见 [tests/e2e/ACCEPTANCE.md](tests/e2e/ACCEPTANCE.md)。

---

*AgentForge v0.1.0 — MVP。规格详见 [AgentForge-Spec.md](AgentForge-Spec.md) 与 [AgentForge-PRD.md](AgentForge-PRD.md)。*

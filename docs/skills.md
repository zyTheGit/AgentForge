# 安装与使用 skill

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

## 投影落点与调用前缀

project scope 下投影 `SKILL.md` 正文，各 target 的调用前缀不同（Spec §8.8，实测结论）：

| target | 落点 | 会话里怎么调 |
|---|---|---|
| opencode | `.opencode\skills\<name>\SKILL.md` | `/<name>` |
| codex | `.agents\skills\<name>\SKILL.md` | **`$<name>`** |
| claude | `.claude\skills\<name>\SKILL.md` | `/<name>` |
| pi | `.pi\skills\<name>\SKILL.md` | `/<name>` |

codex 是四家里唯一用 `$` 的，`/<name>` 不展开。`aforge skill add` 的成功提示与 `aforge status` 都会打印前缀（前者按技能名给出可直接复制的调用形式），不必记。

要点：

- 源仓库布局须为 `<源根>\skills\<name>\SKILL.md`；
- 目标 `skills\<name>` 已有内容 → 退出码 3，先手删该目录再装；
- 源里的 symlink 一律跳过不跟随（防私钥等被读进 SoT），跳过项在输出的 `skipped` 里列出；
- `profile.yaml` 里的 `skills.copy_mode: symlink` **恒被忽略**（投影与安装恒为实体 copy），且已决定**不予实现**（Spec §4.2：与 §7.6 prune 的 hash 判据冲突、Windows 默认无创建权限、四家客户端读取行为未实测）。写了该值 `aforge doctor` 会报 `skills-copy-mode` warn；
- 自己手工 symlink 进 `.agentforge\skills\` 的技能能被 `skill list` 看见、也会被 `sync` 投影，但 `aforge bundle export` 会**整个跳过**它（symlink 一律不跟随），迁移时会丢。`aforge doctor` 现在把这类条目一并报成 `skills-symlink` warn；
- `skills.always` 点了名却没装 → `sync` 直接报错退出码 2；
- 装到 user 层时注意 §5.3 合并语义：`merge.arrays: replace`（缺省）下 project 层自己写了 `skills.always` 就会整体覆盖 user 层那份；
- 附属文件（脚本、参考资料）会拷进 SoT，但当前只有 `SKILL.md` 正文参与投影。

## 按需装载（on_demand）

`skills.always` 与 `skills.on_demand` 都会被 `sync` 物化投影，区别只有一个：**技能要不要进模型的自动路由清单**。

先说清楚一件容易误解的事：四家客户端的技能加载**本来就是按需的**——常驻上下文里只有 `name` + `description` 一行，正文只在技能被选中时才读（claude 给这份清单的预算是上下文窗口的 1%，codex 是 2% 或 8000 字符）。所以「按需」不可能是「AgentForge 先不投影正文、等用的时候再投」：正文不投影，客户端就根本发现不了这个技能。真正可控的只有自动路由这一档。

```yaml
skills:
  always:
    - code-review        # 进模型清单，模型自己判断何时用
  on_demand:
    - deep-research      # 不进模型清单，只在你显式调用时加载
```

`sync` 后：

- 四家的 `SKILL.md` 落点与调用方式**与 `always` 完全相同**（见上表，codex 仍是 `$<name>`）；
- claude / pi 的产物 frontmatter 里多一行 `disable-model-invocation: true`；
- codex 额外多一个 sidecar：`.agents\skills\<name>\agents\openai.yaml`，内容为 `policy: allow_implicit_invocation: false`（codex 的开关不在 frontmatter）；
- `always` 的产物**逐字节等于 SoT 原文**，不受本功能影响。

### 各 target 的支持差异

| target | 关闭自动路由的机制 | 效果 |
|---|---|---|
| claude | frontmatter `disable-model-invocation: true` | description 不进上下文，`/<name>` 显式调用时才加载整个技能 |
| pi | 同上 | 技能从 system prompt 隐藏，须用 `/skill:<name>` |
| codex | sidecar `agents\openai.yaml` 的 `policy.allow_implicit_invocation: false` | 不隐式调用，`$<name>` 仍可用 |
| opencode | **无对应开关** | 未知 frontmatter 键被忽略：技能可用，但仍进模型清单 |

codex 与 opencode 这两行是**实机验证过的**（验证方法与观察到的现象见下）：

- **codex 0.147.0**：隔离 `CODEX_HOME`、CWD 放在与家目录不相干的位置，用 `codex debug prompt-input`（"Render the model-visible prompt input list as JSON"）读模型真正看到的技能清单。只有 `SKILL.md` 的技能在清单里；加上 sidecar 后从清单消失；只写 frontmatter `disable-model-invocation: true` 而不给 sidecar 的技能**仍在清单里**——codex 确实不认这个 frontmatter 键，但也不会因为多这个键而拒绝加载技能。sidecar 里多写一个 codex 不认识的字段仍然生效；sidecar 写成非法 YAML 则整份被忽略、技能退回「和 always 一样」，不会加载失败。
- **opencode 1.15.13**：`opencode debug skill`（列出加载到的全部技能）在隔离 HOME / XDG 目录下跑，三个探针技能——不带额外键、带 `disable-model-invocation: true`、带一个随机未知键——**全部正常列出且都带 description**（即都会进模型清单）。其技能加载器只做 duck-type 校验（`name` 必须是字符串、`description` 可选字符串），`disable-model-invocation` 在其实现里零引用。

opencode 这一档是明确的降级：`aforge doctor` 会报 `skills-on-demand/opencode-unsupported`（warn，不影响退出码），提示在 `opencode.json` 里配 `permission.skill.<name>: "ask"` 或 `"deny"` 自己挡一道。注入那一行对 opencode 是**空操作**——不会让技能失效，也不会关掉自动路由。

还没验证的一条：codex 侧 on_demand 技能的**显式 `$<name>` 调用**。`codex debug prompt-input` 只渲染提示词，不做技能正文展开（`$name` 在这一层不被替换），要确认得开一次真会话。上游文档（codex 自带的 skill-creator 说明）写的是 "When false, the skill is not injected into the model context by default, but can still be invoked explicitly via `$skill`"。

### 缺失与冲突的处理

- **点名却没装**：不像 `always` 那样 fail-fast。`sync` 照常成功，输出里一行 `[on_demand] <name>: not installed in either SoT layer ...`，`doctor` 报 `skills-on-demand/<name>` warn。`on_demand` 的定位就是「备货清单」，允许先写名字再逐个 `aforge skill add <name> --no-register`；
- **同名同时在 `always` 里**：按 `always` 投影（仍进模型清单），不注入按需标记，`doctor` 报 warn 提示要先从 `always` 里摘掉；
- **`SKILL.md` 没有 frontmatter**：正文照常投影，但无处注入标记，按需语义不生效（`doctor` warn）。四家客户端本来也要求 `name` / `description` 必填，这种文档本身就该补 frontmatter；
- **`expose_as_command` 只认 `always`**：命令薄壳是「强制调用」的手段，与「别自动用它」的诉求正交；点名一个只在 `on_demand` 里的技能仍是退出码 2。

### 两张名单之间迁移

改完名单跑一次 `sync` 即可，产物差异由 §7.6 prune 收敛：

- `always` → `on_demand`：`SKILL.md` 路径不变、内容被覆盖（多一行标记），codex 的 sidecar 新建；
- `on_demand` → `always`：`SKILL.md` 恢复原文，sidecar 被删除并列进 `pruned`；
- 两张名单都摘掉：四份 `SKILL.md` 与 sidecar 全部删除（手工改过的那份保留并进 `prune skipped`）。

`aforge status` 的 `on_demand` 行会标注 `(projected, hidden from model auto-routing - invoke explicitly)`，`aforge doctor` 的 `skills-on-demand` 条目列出本轮真正生效的名字。

## 额外投影成命令（expose_as_command）

装好的技能四家都能直接调（上表），所以命令薄壳**默认不产出**。只有需要下面两件事时才开：

- **强制调用**：`/<name>` 是确定性文本展开，不经模型判断该不该触发；
- **位置参数**：技能正文只有 `$ARGUMENTS` 一档，命令层可用 `$1..$9`。

在 `profile.yaml` 里点名（必须是 `skills.always` 的子集，否则 `sync` 退出码 2）：

```yaml
skills:
  always:
    - code-review
  expose_as_command:
    - code-review
```

`sync` 后各 target 的落点（一名一文件，注意 opencode 是单数 `command`）：

| target | 落点（project scope） |
|---|---|
| opencode | `.opencode\command\<name>.md` |
| claude | `.claude\commands\<name>.md` |
| pi | `.pi\prompts\<name>.md` |
| codex | **不产出**（只认 user 级 `%CODEX_HOME%\prompts\`） |

薄壳只写「加载技能 X、按其工作流执行、用户输入见 `$ARGUMENTS`」，不复制技能正文（避免两份漂移）；frontmatter 只透传 `SKILL.md` 的 `description` 与 `argument-hint`。

- codex 在 project scope 被整项跳过，`sync` 输出里有一行 `[codex] commands skipped: ...`，`aforge doctor` 报 `commands/codex-project-unsupported`（warn，不影响退出码）。codex 侧直接用 `$<name>` 调技能即可；要命令文件就在 user scope（`AGF_HOME` 层）声明；
- 命令文件是整文件产物：从 `expose_as_command` 摘名后由下一次 `sync` 删除并列进 `pruned`，手工改过的那份保留并进 `prune skipped`（同技能投影，Spec §7.6）。

### 位置参数（`command-body`）

默认薄壳只有 `$ARGUMENTS`。要用 `$1..$9`，在 `SKILL.md` 的 frontmatter 里写 `command-body`，整段作为命令正文透传（该字段本身不会出现在产物 frontmatter 里）：

```yaml
---
name: code-review
description: 审查代码变更
command-body: |
  审查 $1 分支上的 $2，其余上下文见 $ARGUMENTS。
---
```

占位符白名单只有 `$ARGUMENTS` 与 `$1..$9`（四家实测交集）。写 `${1:-默认值}`、`$0`、`$10`、`$@` 等 → `sync` 退出码 2。

### 命名空间

`expose_as_command` 的条目可以带命名空间前缀，最后一段是技能名（仍必须在 `skills.always` 里）：

```yaml
skills:
  expose_as_command:
    - review/code-review
```

- claude / opencode 落成子目录：`.claude\commands\review\code-review.md`（调用 `/review:code-review`）、`.opencode\command\review\code-review.md`（调用 `/review/code-review`）；
- pi / codex 的命令目录是平铺的，降级为 `review-code-review.md`（用 `-` 而非 `:`——`:` 在 Windows 文件名里非法），调用时用这个拼接后的名字。target 里含 pi / codex 时 `aforge doctor` 报 `commands/namespace-flattened` warn 列出改名结果；
- 段内不能为空、不能是 `.` / `..`、不能含 `\ : * ? " < > |`；扁平化后撞车（`a/x` 与已有的 `a-x` 并存）→ 退出码 2。

## 注销技能

不想再让某个技能被投影时用 `skill remove`——它**只**把名字从该层 `profile.yaml` 的 `skills.always` 摘掉，`skills\<name>\` 目录原样留在磁盘上：

```powershell
aforge skill remove find-skills
# skill removed: find-skills (profile only)
#   scope     : project
#   profile   : D:\proj\.agentforge\profile.yaml
#   always    : pdf-tools
#   skill dir : D:\proj\.agentforge\skills\find-skills (kept on disk)
#
# note: removed from profile.yaml only. run `aforge sync` to drop the
#       projected copies (project level):
#         D:\proj\.opencode\skills\find-skills\SKILL.md
#         D:\proj\.agents\skills\find-skills\SKILL.md
#         D:\proj\.claude\skills\find-skills\SKILL.md
#         D:\proj\.pi\skills\find-skills\SKILL.md
#       manually edited copies are kept and listed under `prune skipped`.
```

- **投影产物由下一次 `aforge sync` 清理。** 摘除只作用于 SoT；再跑一次 `sync` 会按上一轮记账（`sync-meta.json` 的 `artifacts`）删掉 `.claude\skills\<name>\SKILL.md`（`.opencode` / `.agents` / `.pi` 同理），并在输出的 `pruned` 里列出。只删内容仍与记账一致的文件——手工改过的那份会保留并报进 `prune skipped`，详见 Spec §7.6；
- `--scope project|user` 指定改哪一层（缺省同 `add`：AGF_SCOPE > project 在用 > user 在用）；两层都登记了同名技能时要各删一次；
- 该层 `skills.always` 里没有这个名字 → 退出码 2（不当成幂等成功，多半是层选错了）。错误提示会说明目录是否还在盘上；如果另一层登记了同名，提示会直接给出可复制的 `--scope <另一层>`；
- 摘完 `always` 只剩空数组时那一行显示 `(none)`；注意 `merge.arrays: replace` 下空数组**仍会覆盖** user 层，要让 user 层的同名技能重新生效得手工删掉 project 层的整个 `skills.always` 键；
- 要腾空间 / 想重装，删完登记后手工删除 `skills\<name>\`（`skill add` 遇到已存在且非空的目录会报退出码 3）。

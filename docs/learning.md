# 沉淀 learning

## 人工记录与晋升

```powershell
# 记一条（不投影）：交互终端直接跑会提示粘贴多行内容
aforge learn
# 脚本 / agent 里从文件或 stdin 读（非交互终端且未给 --file → 退出码 2）
aforge learn --file notes.md                                  # 直接给路径（多行正文最省事）
echo "Use pnpm, never npm, in this repo." | aforge learn --file -   # 管道读正文
aforge learn --file - < notes.md                              # 重定向读正文
# 自己拍一个置信度（省略则自动打分，见下）
aforge learn --file notes.md --confidence 0.9

# 看 / 改 / 删
aforge learnings list
aforge learnings show <id>
aforge learnings edit <id>   # 交互终端里拉起 $EDITOR（缺省 notepad）
aforge learnings rm <id>

# 晋升为 custom 规则或 skill，再投影
aforge promote <id> [--to user] [--yes]
aforge sync
```

`learn` 只写 SoT 的 `learnings/`，不动投影产物；`promote` 也只写 SoT——真正落到各 Agent 规则文件里要靠 `aforge sync`。`profile.yaml` 里 `learning.auto_promote: true` 时 `learn` 会顺手 promote，`--no-auto-promote` 可单次关掉。

`--file -` 读的是**要沉淀的条目正文**，且只接管道或重定向：交互终端里裸敲 `aforge learn --file -` 会退出码 2 并给出三条正确形态，而不是挂在那里等 EOF（Windows 上要 Ctrl+Z 回车）。交互粘贴走不带 `--file` 的 `aforge learn`。

`learnings edit <id>` 在交互终端（stdin/stdout 都是 TTY）里用 `$EDITOR`（缺省 `notepad`）打开条目 yaml，等编辑器退出后立刻重校验：内容不合 §4.3 → 退出码 2 并指出问题字段；文件被删掉 → 只提示，不报错。三种情况退回「打印文件路径 + 正文」的手工编辑提示而**不**报错：非交互环境（CI / 管道）、`--json`、`$EDITOR` 在 PATH 上解析不到。

`CI` 为真时 `aforge learn` 一律被拒（退出码 2），learnings 恒不落盘。

## confidence：自动打分、时间衰减、相似度判重

三件事共用一条原则：**能算出来的不落盘**。`learnings/<id>.yaml` 里只有 `confidence`（base 值）与 `confidence_source`（`auto` / `manual`），衰减后的 effective 值和打分明细都是 `learnings list|show` 读时现算的——否则每看一次列表就要重写一遍条目文件，SoT 的 git diff 会被写放大污染，还会和 `sync` / `promote` 抢锁。

### 自动打分

省略 `--confidence` 时按六个可解释信号加权打分（`aforge learnings show <id>` 会把明细打出来）：

| 信号 | 权重 | 判据 |
| --- | --- | --- |
| `length` | 0.20 | 正文长度：< 12 字符得 0，12–40 线性上升，40–600 满分，超过 600 递减到地板 0.3（太长通常是整篇粘贴、未提炼） |
| `actionable` | 0.25 | 是否含可照抄的执行信息，三类各占 1/3：围栏代码块、行内 code、已知命令名白名单（`npm` / `pnpm` / `git` / `uv` / `docker` / `aforge` …） |
| `reference` | 0.15 | 是否引用具体位置，两类各占 1/2：带已知扩展名的文件名、含分隔符的路径片段 |
| `directive` | 0.10 | 是否是一条**规范性**表述（必须 / 禁止 / 一律 / `must` / `never` / `prefer` …）。二值——一条要么是规则，要么只是观察 |
| `metadata` | 0.20 | `trigger` / `category` / `promote_target` 三项是否偏离默认值，各占 1/3 |
| `scope` | 0.10 | `project` 得 1，`user` 得 0.5（项目内的约定更具体、更可验证） |

加权和 ∈ [0,1] 线性映射到 **[0.2, 0.9]** 后保留两位小数。上下限是刻意留的：启发式再差也不该断言"完全不可信"，再好也不该断言"几乎确定"——那是人给 `--confidence` 的事。

打分是**纯函数 + 无时钟**：`scoreConfidence` 只看条目落盘后的字段（默认值已解析），所以 `learnings show` 对一条老条目重算出的明细，与它当初创建时的完全一致；权重表改了也不会留下一堆过期的历史明细。命令名与路径这类正则信号只扫描正文**前 4000 字符**（更长的正文本身已被 `length` 压到地板，而无分隔符的超长串会让路径正则退化成 O(n²) 回溯）。

`--confidence <0-1>` 显式给值时跳过打分，`confidence_source` 记为 `manual`；取值非数字或越界 → 退出码 2（不静默退化成自动打分）。交互模式下 confidence 那一问留空即为自动打分。`aforge learnings edit` 之后手改了 `confidence` 但没改 `confidence_source` 时，下一次 `updateLearning` 会把来源翻成 `manual`。

### 时间衰减

```
promoted           → effective = base                       # 已落成产物，置信度由产物承担
age <= 30 天       → effective = base                       # 宽限期
否则               → effective = base x (0.25 + 0.75 x 0.5 ^ ((age - 30) / 90))
```

`age` 取距 `updated_at` 的天数（不是 `created_at`）：条目被再次命中或复核时 `updated_at` 前移，正对应"又被用到了"，衰减随之重置。半衰期 90 天，地板 `base x 0.25`——旧不等于错，只是该复核，压到 0 会让排序失去区分度。结果对 `age` 单调不增且恒在 `[0, base]` 内。超过 **180 天**仍未 promote 的条目标记为 stale，`learnings show` 会提示 promote 或删掉。

衰减也是纯函数，`now` 由命令层从 host 注入，不读系统时钟——这样测试稳定，投影产物的 `contentHash` 也不会随机器时间漂移。

### 输出里怎么读

`learn` 与 `learnings list` 的那一列是同一口径：未衰减只印一个数与来源，衰减后才展开 base 与天龄。

```
# aforge learn 的 conf 行 / learnings list 的第四列
0.72 (auto)                              # 在宽限期内，或已 promote（不衰减）
0.31 (auto, base 0.72, 214d stale)       # 已衰减；超过 180 天未 promote 才带 stale

# aforge learnings list：id / 层 / 状态 / category / conf / trigger
  l20260902043900-a1b2c3  [project]  draft     tooling     0.72 (auto)  when adding deps
```

`aforge learnings show <id>` 先原样打印条目 yaml，再追加一段 `confidence` 明细——`effective` / `base`（含来源）/ `age`（尾注为 `(promoted - no decay)`、`(within grace period)` 或 `(decaying)`）/ `heuristic` 与逐信号得分：

```
== confidence ==
  effective : 0.31
  base      : 0.72 (manual)
  age       : 214d (decaying)
  heuristic : 0.55 (signals below)
    - length      1.00 x 0.20  正文长度落在可读区间
    - actionable  0.67 x 0.25  含可照抄的执行信息（代码块 / 命令）
    ...
```

（上面是 ASCII 档的样子；能显示 unicode 的终端里段头与列表符号换成 `▸` / `•`，字段与数值不变。）

注意 `heuristic` 是**当场重算**的启发式分：`base` 是 `manual` 时它只表示"自动打分本来会给多少"，不是落盘值的来源。`confidence_source` 缺席的旧条目（自动打分上线前记的）显示为 `unknown`。

`--json` 下这些落在 `quality` 对象里：`confidenceBase` / `confidenceEffective`（两位小数）/ `confidenceSource`（`auto` / `manual` / `null`）/ `ageDays`（一位小数）/ `decayed` / `stale` / `heuristic.{value,weighted,signals}`。

### 相似度判重

算法是**归一化后的字符 trigram Jaccard**（不引新依赖）。归一化 = NFKC + 小写 + 把标点与空白折叠为单空格。为什么不按空白分词做 token Jaccard：learning 正文中英混排，中文不带空格，整句会退化成一个 token，判重直接失效；字符 trigram 对 CJK 天然可用，对词形词序的小改写也更鲁棒。正文短于 3 个字符时退化为整串相等比较。

判重只比**未晋升**条目（已 promote 的要合并得先回退产物，超出"给一条提示"的范围），两档阈值：

| 相似度 | 判定 | 行为 |
| --- | --- | --- |
| >= 0.92 | 重复 | 走既有的 §7.5 路径：**仍创建**，输出 `content duplicates unpromoted entry <id>` 警告（`--json` 的 `duplicateOf`） |
| 0.65 – 0.92 | 相似 | 不阻断，输出 `similar to <id> (N%) - consider merging instead of keeping both`（`--json` 的 `similarTo`） |
| < 0.65 | 无关 | 无提示 |

阈值取值的依据：全等恒为 1.0，只差标点大小写的改写归一化后同样是 1.0，所以 0.92 这一档实际只覆盖"实质同一句"；同一条约定的两种措辞（一方多一个补充分句）经验上落在 0.65–0.90。

**不做自动静默合并。** roadmap 的「非目标」明确排除无人值守的全自动晋升，合并两条学习同样需要人看一眼——命令只给建议，合并动作由 `aforge learnings edit` / `rm` 完成。

## 让 agent 自己记（`learning.auto_capture`）

缺省 `off`：learning 只能人工敲 `aforge learn`。想让 agent 在会话里主动沉淀，把项目或用户层 `profile.yaml` 改成：

```yaml
learning:
  auto_capture: prompt
```

再 `aforge sync`，投影正文（marker 区间内）会多出一段固定的 `## Learning Protocol`，指示 agent 把达成的约定用 `aforge learn --file -` 写进 SoT。四点边界：

- **概率性**：模型可能不执行——这一档只是把协议写进规则，不是钩子；
- **只写 SoT，不投影**：agent 写完的条目仍要人工 `aforge promote` + `aforge sync` 才进投影；
- **CI 里不会真的采集**：`CI` 为真时 `aforge learn` 被拒（learnings 恒不落盘），但**这一段照样渲染**——投影产物与环境无关，同一份 SoT 在 CI 与本机的 `contentHash` 一致，`aforge doctor` 的 hash 比对才不会误报漂移。`status` / `doctor` 会补一句"本次不会写入"；
- **别和 `auto_promote: true` 同开**：agent 照协议敲的 `learn` 会连带 promote，而 promote 取的是与 `sync` 同一把 `.sync.lock`，你手动 `aforge sync` 时并发就报退出码 3。`aforge doctor` 会为这个组合报一条 warn。

`auto_capture: hook` 见下一节。

把值改回 `off` 再 sync，该段随 marker 区间一并消失，marker 外的手写内容不受影响。

## `auto_capture: hook`（会话钩子投递协议）

```yaml
learning:
  auto_capture: hook
```

再 `aforge sync`。这一档**不往规则文件里插正文**（与 `prompt` 互斥，同时插等于同一份协议出现两遍），改由 target 的 `SessionStart` 钩子在每次会话开始时把同一份 `## Learning Protocol` 正文注入上下文——比 `prompt` 的"模型要在一篇长文档里读到它"确定性更高。

### 支持矩阵

| target | 支持 | 理由 |
| --- | --- | --- |
| codex | 是 | 支持"独立文件 + 纯配置数据"的钩子声明（`<config 层>\hooks.json`），实测 codex 0.147.0 |
| claude | 否 | 钩子只能并入共享的 `.claude\settings.json` 的 `hooks.<Event>` **数组**，而 `merge_json` 对数组是整体替换（Spec §8.2），会吞掉你手写的钩子 |
| opencode | 否 | 会话事件要投放可执行的 plugin **代码**才能用，不是配置数据 |
| pi | 否 | 同上，要投放可执行的 extension 代码 |

判据是"能不能只靠写配置数据把钩子装上"，不是"上游有没有会话生命周期事件"。背后是两条原则各管一半：

- **不静默覆盖用户写的东西**：claude 有钩子，卡的是写法——`hooks.<Event>` 那个数组你自己也在写，整体替换一次就把你的 `hooks.SessionStart` 吞了。宁可如实降级；
- **不往 agent 配置目录投放可执行代码**：opencode / pi 的会话事件只对 plugin / extension 开放（pi 上游自己写着 "Extensions run with your full system permissions"），那是另一个量级的信任边界，也让 §7.6「改过的不删」形同虚设——你改一行 `.ts`，AgentForge 就再也清不掉它。

[声明式适配器](profile.md#声明式适配器第三方-target)注册的第三方 target 同样恒为"不支持"，理由同上。

**不支持的 target 在这一档行为等同 `off`，但不静默**——三个出口说同一件事，措辞共用一份常量：

```
# aforge sync（--dry-run 同样打印，且不落盘）
[claude] claude 没有可声明式写入的会话钩子落点，learning.auto_capture: hook 对该 target 等同 off（其余产物照常投影）

# aforge status 的 learning 一节
  auto_capture: hook
                session hook (SessionStart) written for: codex
                no session hook target: claude, opencode, pi (behaves as off)
```

`aforge doctor` 报一条 `learning-auto-capture-hook` 的 warn（`auto_capture: hook 对以下已启用 target 等同 off……：claude / opencode / pi`）；一家都装不上时 hint 直接建议改用 `auto_capture: prompt`，`status` 也会补一句 `no enabled target supports session hooks - behaves as off`。

这些提示**不是** `warnings`——`warnings` 里出现某个 target 会让本轮不为它记账，§7.6 的 prune 从此清不掉它的产物。该 target 的其余产物照常投影，退出码也不受影响。

### 钩子实际做什么

写进 codex 的 `hooks.json`（`<项目>\.codex\hooks.json`，user scope 落 `CODEX_HOME` 或 `~\.codex\`）：

```json
{
  "description": "Managed by AgentForge (learning.auto_capture: hook). ...",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "aforge learn --print-protocol",
            "statusMessage": "AgentForge: injecting learning protocol",
            "additionalContextLimit": 4000
          }
        ]
      }
    ]
  }
}
```

- **事件取 `SessionStart` 而非 `SessionEnd`**：会话结束时钩子只拿到 transcript 路径，而护栏 4 禁止把会话原文写进 learnings，且此刻模型已经不能再说话、没人能产出结构化的条目正文。"会话结束后自动 capture"在护栏内不成立，因此这一档只做确定性的**协议投递**，条目内容仍由 agent 在会话中经 `aforge learn` 自己写；
- **matcher 不含 `compact`**：压缩后的续跑属同一会话，协议已经注入过一次；
- `aforge learn --print-protocol` 是**只读旁路**：只往 stdout 打印那段常量正文，不解析配置、不读 SoT、不写盘、不取锁、不进交互。因此它不触发 `learn` 的 CI 守卫（守卫拦的是 `createLearning`）、无 TTY 也不会挂住、也不与你手动 `aforge sync` 争 `.sync.lock`（取锁的是 `promote`）。

### 安全与清理

- **命令是常量**：不拼接任何路径、profile 字段或用户数据，所以路径里的空格 / 引号 / 中文都进不了命令串，注入面为零；
- **不写本机路径**：裸 `aforge` 交给 PATH 解析，钩子文件在任何机器上逐字节相同 → 产物不随宿主漂移。代价是没把 `aforge` 放进 PATH 时钩子会静默失败（codex 把非零退出当作"该钩子没产出上下文"，会话照常），这比硬编码一个版本切换后就失效的绝对路径要好；
- **写入前看得见**：`aforge sync` 会打印这一项，`--dry-run` 同样能看到（且不落盘）；
- **`hooks.json` 由 AgentForge 独占**：因此用整文件 `write` 动作，直接落进 §7.6 的 artifacts 记账。把 `auto_capture` 改回 `off` / `prompt` 再 sync，这个文件被 prune 整个删掉（你手工改过它则跳过删除并提示，不会静默吞掉改动）；
- **一层一种表示**：codex 在同一 config 层同时读 `hooks.json` 与 `config.toml` 里的 inline `[hooks]`，两者并存会在启动时告警（上游建议 "prefer one representation per layer"）。如果你已经手写了 inline `[hooks]`，把它挪进 `hooks.json` 之外的层，或不要用这一档。`aforge doctor` 会实际读一遍 `config.toml`，检测到并存时报 `learning-auto-capture-hook-inline` warn（只提示，不阻断 sync）；
- **不覆盖没记账过的文件**：落点上已经有一个 AgentForge 没记过账的 `hooks.json` 时，首次 sync 以 ConflictError（退出码 3）停下并列出路径，确认可以丢弃后用 `aforge sync --force` 覆盖。手写过 `hooks.json` 的用户不会在开启这一档时被静默清掉。

**声明驱动，不做探测**：写不写钩子只看 `profile.targets` 与各 target 的能力声明，不看本机装没装 codex、装在哪。同一份 SoT 在两台机器上产出同样的投影产物与同一个 `contentHash`。

### 手工挂载：把协议塞进没有落点的三家

AgentForge 不替 claude / opencode / pi 装钩子（理由见上表与本页末的前置条件），但那条命令本身是公开的只读旁路，你可以自己挂：

```powershell
aforge learn --print-protocol                      # 打印协议正文（只读：不解析配置、不写盘、不取锁）
aforge learn --print-protocol | Set-Clipboard      # 粘进你自己的系统提示 / 会话模板
aforge learn --print-protocol > .\my-hooks\session-start.txt
```

按 target 的挂法：

- **claude**：自己写 `.claude\settings.json` 的 `hooks.SessionStart` 调这条命令。AgentForge 不写这个文件，所以你手写的部分不会被 sync 覆盖也不会被 prune 掉——这正是它不自动接管的另一面；
- **opencode / pi**：会话事件只对 plugin / extension **代码**开放，AgentForge 不投放可执行代码；要挂就在你自己的 plugin / extension 里 exec 这条命令；
- **任何 target**：最省事的做法是把输出粘到规则文件 marker **之外**的区域（marker 内会被下次 sync 整体替换）。

**但先考虑 `auto_capture: prompt`。** 那一档由 AgentForge 把同一份正文渲染进 marker 区间，一次 sync 覆盖全部 target，无需你维护任何钩子——三家的推荐路径是它，手工挂载只在你已经有自己的钩子体系、且需要「每次会话开头确定性注入」时才值得。

**不要把这条命令的输出喂回 `aforge learn`。** `--print-protocol` 打印的是**给 agent 看的指令**，`aforge learn --file -` 读的是**要沉淀的条目正文**；把前者管道进后者只会把协议本身存成一条 learning。两者的正确衔接是：协议正文里已经写着让 agent 自己去执行 `aforge learn --file -`。

### 另外三家将来要支持的前置条件

记在这里是为了说明"为什么现在不做"不等于"以后也不做"，以及要做的话先得解决什么。

**claude** 需要先给 `merge_json` 引入数组级合并语义，四条同时成立才安全：只作用于明确白名单的键路径（不能变成 `merge_json` 的普遍行为，否则所有 JSON 落点的数组都跟着改语义）；对数组**只增不减**；AgentForge 加的条目带可识别标记（否则 `auto_capture` 改回 `off` 时 §7.6 的 prune 无从按元素删除——那是用户的 `settings.json`，不能整文件删）；并定义好"用户手工改过被标记的条目"时怎么办（保留还是 `ConflictError(3)` 停下）。本仓库**不做**：这一圈特例语义的风险面大于它换来的收益。

**opencode / pi** 要先回答与[声明式适配器](profile.md#声明式适配器第三方-target)同一批安全问题——投放到用户配置目录的可执行代码由谁审、从哪一层发现（适配器的答案是只认 user 层，project 层需 `AGF_ALLOW_PROJECT_ADAPTERS=1` 显式授权）、以及 prune 的"改过的不删"保护在 `.ts` 文件上还剩多少。

**真正的"会话结束抽取"**（把 transcript 变成结构化条目）另需先回答：谁来做这次抽取（再起一次模型调用？），以及那次调用的成本与准确率是否值得。


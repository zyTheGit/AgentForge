# 沉淀 learning

## 人工记录与晋升

```powershell
# 记一条（不投影）：交互终端直接跑会提示粘贴多行内容
aforge learn
# 脚本里从文件或 stdin 读（非交互终端且未给 --file → 退出码 2）
aforge learn --file notes.md
aforge learn --file - < notes.md
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

`auto_capture: hook`（由 target 侧会话钩子确定性触发）**当前未实现**，行为等同 `off`，`aforge doctor` 会报一条 warn 而不是静默失效。

把值改回 `off` 再 sync，该段随 marker 区间一并消失，marker 外的手写内容不受影响。

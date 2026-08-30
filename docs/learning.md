# 沉淀 learning

## 人工记录与晋升

```powershell
# 记一条（不投影）：交互终端直接跑会提示粘贴多行内容
aforge learn
# 脚本里从文件或 stdin 读（非交互终端且未给 --file → 退出码 2）
aforge learn --file notes.md
aforge learn --file - < notes.md

# 看 / 改 / 删
aforge learnings list
aforge learnings show <id>
aforge learnings edit <id>
aforge learnings rm <id>

# 晋升为 custom 规则或 skill，再投影
aforge promote <id> [--to user] [--yes]
aforge sync
```

`learn` 只写 SoT 的 `learnings/`，不动投影产物；`promote` 也只写 SoT——真正落到各 Agent 规则文件里要靠 `aforge sync`。`profile.yaml` 里 `learning.auto_promote: true` 时 `learn` 会顺手 promote，`--no-auto-promote` 可单次关掉。

`CI` 为真时 `aforge learn` 一律被拒（退出码 2），learnings 恒不落盘。

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

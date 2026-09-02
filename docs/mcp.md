# 登记 MCP 服务器

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

`transport` 的三个取值（`stdio` / `http` / `sse`）是 AgentForge 侧的语义，**不随客户端能力变化**；哪个 target 能无损表达、哪个只能降级或跳过，见下面的[支持矩阵](#transport--target-支持矩阵)。`http` 指 streamable HTTP，`sse` 指旧的 HTTP+SSE——大多数远端端点两种都开，优先选 `http`。

## 移除

不想再用某个 server 时用 `mcp remove` 把声明从该层 `mcp.servers` 里摘掉：

```powershell
aforge mcp remove jenkins-config
# mcp server removed: jenkins-config
#   transport : stdio
#   scope     : project
#   profile   : D:\proj\.agentforge\profile.yaml
#   servers   : ctx7
#
# note: removed from profile.mcp.servers only. run `aforge sync` to drop the
#       "jenkins-config" entry from these project-level files:
#         D:\proj\opencode.json
#         D:\proj\.mcp.json
#         D:\proj\.pi\mcp.json
```

- **投影里的 server 键由下一次 `aforge sync` 摘除。** `sync` 按上一轮记账（`sync-meta.json` 的 `mcpServers`）算差集，把被删的 server 从 `opencode.json` / `.mcp.json` / `.pi\mcp.json` 里摘掉，文件本身与其余键原样保留。这不违背 merge_json 的「未知键一律保留」（Spec §8.2）——摘的只是记账里认领过的键；codex 的 `.codex\config.toml` 走 marker 段整段重写，本来就会自动跟上。详见 Spec §7.6；
- `--scope project|user` 指定改哪一层（缺省同 `add`）；`--json`（或 `aforge --json mcp remove <name>`）输出机器可读结果，含被删条目 `removed` 与该层剩余 `servers`；
- 该层没有这个名字 → 退出码 2，错误消息会列出该层现有的 server 名；如果另一层登记了同名，提示会直接给出可复制的 `--scope <另一层>`；
- 摘掉最后一条后 `servers` 一行显示 `(none)`；
- 只想临时停用而保留配置的话，别用 remove——把声明里的 `enabled` 改成 `false` 重新 `add`（同名 upsert）即可。

## 投影落点（project scope）

- opencode → `opencode.json` 的 `mcp` 键（merge_json，未知键保留）
- codex → `.codex\config.toml` 的 `# BEGIN AGENTFORGE MCP` 标记段（merge_toml，段外 TOML 与注释原样保留）
- claude → `.mcp.json` 的 `mcpServers` 键（merge_json）
- pi → `.pi\mcp.json` 的 `mcpServers` 键（merge_json，**soft 项**：写失败只报 warning，不算 sync 失败、不触发回滚）

pi 本体不内建 MCP，先装适配扩展才生效：`pi install npm:pi-mcp-adapter`（见 <https://pi.dev/packages/pi-mcp-adapter>）。写 `.pi\mcp.json` 而不是根 `.mcp.json`，是为了不与 claude 的投影争用同一路径（同一次 sync 里两个 projector 写同一文件会互相覆盖）。适配器优先级：`.pi\mcp.json`（项目级）> `.mcp.json`（项目共享）> `<Pi agent dir>\mcp.json`（user 级，即 user scope 的落点）> `~\.config\mcp\mcp.json` / `~\.agents\mcp.json`——user 级 pi 配置会被任何项目的 `.mcp.json` 盖掉，别把它当兜底。user scope 的 `<Pi agent dir>` 认 `PI_CODING_AGENT_DIR`（缺省 `~\.pi\agent`），`aforge doctor` 会把生效目录打出来。

> 升级提示：早期版本把 pi 的 MCP 写在 `.pi\settings.json`（user 级 `~\.pi\agent\settings.json`）。现在落点是同目录的 `mcp.json`，旧文件**不会被自动迁移或删除**——确认新 `mcp.json` 生效后请手工删掉旧文件里的 `mcpServers` 键（整份文件没有你自己的 pi 设置时可直接删除）。`aforge doctor` 会把它报为 `residual/pi-legacy-mcp` warning。

## 投影落点（user scope）

`--scope user` 的声明投影到三家，**claude 不在其中**：

- opencode → `~\.config\opencode\opencode.json` 的 `mcp` 键
- codex → `~\.codex\config.toml` 的标记段（认 `CODEX_HOME`）
- pi → `<Pi agent dir>\mcp.json`（认 `PI_CODING_AGENT_DIR`，缺省 `~\.pi\agent`）
- claude → **不投影**，`aforge sync` 会打一条 `[claude] mcp skipped: ...`，`aforge doctor` 报一条 `mcp-scope/claude-user` warn

为什么不投影 claude 的 user 级 MCP：上游只认 `~\.claude.json` 的顶层 `mcpServers`（实测 Claude Code 2.1.220：`~\.claude\settings.json` 里的 `mcpServers` 不被读取，`~\.mcp.json` 也不是 user 级来源），而那个文件同时是 claude 的**运行时状态转储**——会话历史、成本与 token 统计、项目信任标记、`--scope local` 加的 MCP 声明都在里面，claude 每次启动/结束都重写它。AgentForge 的 merge_json 是整文件读改写，与正在运行的 claude 抢写会把它那次写入整份丢掉。没有共享锁协议能关掉这个窗口，所以宁可不写。

要让 MCP 在 claude 的所有项目里生效，两条路：

```powershell
# 1) 交给 claude 自己写（推荐）
claude mcp add --scope user jenkins-config -- npx -y @zythegit/jenkins-config-mcp

# 2) 或者把声明放到项目层，走 .mcp.json 投影（可入库共享）
'{"name":"jenkins-config","transport":"stdio","command":"npx","args":["-y","@zythegit/jenkins-config-mcp"]}' |
  aforge mcp add --from-json --scope project
aforge sync
```

`--scope local`（落在 `~\.claude.json` 的 `projects.<路径>.mcpServers`）不进 AgentForge 的 scope 模型，理由同上——同一个文件、同样的风险。

> 升级提示：早期版本的 user scope claude MCP 写在 `~\.mcp.json`（claude 从不把它当 user 级配置读，所以那轮投影对 claude 一直是无效的）。现在整项不再投影，旧文件**不会被自动迁移或删除**：`sync` 的 §7.6 prune 也碰不到它（merge_json 的文件不进 `artifacts` 记账，而 server 键的差集摘除只遍历本轮 planned 的 merge_json 项）。`aforge doctor` 会把含 `mcpServers` 的 `~\.mcp.json` 报为 `residual/claude-legacy-user-mcp` warning，请据它手工删掉那个 `mcpServers` 键（整份文件没有你自己的配置时可直接删除）。


## transport × target 支持矩阵

你只写一份声明，四个客户端的 MCP schema 各不相同，翻译由投影层的归一化表（`src\core\project\projectors\mcp-transport.ts`）统一负责。**上游能力不同，同一个 `transport` 在不同 target 上的结局也不同：**

| transport | claude | opencode | codex | pi |
| --- | --- | --- | --- | --- |
| `stdio` | 无损 | 无损 | 无损 | 无损 |
| `http`（streamable HTTP） | 无损 | 无损 | 无损 | 无损 |
| `sse` | 无损 | **降级**：按 streamable HTTP 连接 | **跳过**：整条不写入 | 无损 |

各家的能力边界与实际字段：

- **claude**（`.mcp.json` 的 `mcpServers`）：三种 transport 全都原生支持，条目一律显式带 `type`（`"stdio"` / `"http"` / `"sse"`）。stdio 用 `command` / `args` / `env`，远端用 `url` / `headers`。形状与 `claude mcp add` 自己写出来的一致。
- **opencode**（`opencode.json` 的 `mcp`）：`type` 只有 `local` / `remote` 两种，remote 侧的字段只有 `url` / `headers` / `oauth` / `timeout` / `enabled`——**上游没有任何字段能声明 SSE**。所以 `transport: sse` 会和 `http` 一样落成 `type: "remote"`，opencode 按 streamable HTTP 连接。这不是 AgentForge 偷懒，是上游确实不区分；AgentForge 的做法是照实投影 + 显式告警，不发明上游不认的字段。
- **codex**（`.codex\config.toml` 的标记段）：只支持 STDIO 与 Streamable HTTP，**没有 SSE**。`transport: sse` 的 server **整条不写进标记段**——写进去 codex 也认不了，反而让用户以为生效了。远端条目的鉴权头键名是 `http_headers`（不是 `headers`，写错 codex 会静默忽略）。另外每个 server 是**单表** `[mcp_servers.<name>]`，不是数组表 `[[mcp_servers.<name>]]`：写成数组表会让 codex 整份 `config.toml` 解析失败（`invalid type: map, expected a string`），不只是这一段失效。
- **pi**（`.pi\mcp.json` 的 `mcpServers`，需 `pi-mcp-adapter`）：条目**没有 `type` 字段**，适配器按 `command` / `url` / `socket` 互斥来判定 transport。只给 `url` 时默认 streamable HTTP 并允许回落 SSE；`transport: sse` 会额外写 `httpTransport: "sse"` 锁定 SSE 并关掉回落，所以 SSE 在 pi 上是无损的。顶层键名与 Claude Code 同名，但条目形状**不同构**，别照抄。

**表达不了的时候不会静默。** 降级（opencode × sse）与跳过（codex × sse）都会出现在两个地方：

- `aforge sync` 输出的 `mcp transport notices:` 段，逐条给出 `[target] degraded/skipped` 与改法建议；
- `aforge doctor` 的 `mcp-transport/<target>/<server>` warn 项。

这些都是 **warn 级、不影响退出码**：投影结果已经是该 target 能达到的最佳形态，落差来自上游能力边界，不是 AgentForge 的失败。想消除告警：端点同时支持 streamable HTTP 就把声明改成 `transport: http`（语义一致）；只支持 SSE 的端点就把该 target 从 `profile.targets` 里去掉，或只在 claude / pi 侧使用。

`enabled: false` 的 server 一律不投影、也不报落差。

以上面的 jenkins-config（stdio）为例，`sync` 后 `.mcp.json` 里会多出：

```json
{
  "mcpServers": {
    "jenkins-config": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@zythegit/jenkins-config-mcp"]
    }
  }
}
```

同一条声明在其他三家的形状：

- opencode：`{ "type": "local", "command": ["npx", "-y", "@zythegit/jenkins-config-mcp"], "enabled": true }`
- codex：`[mcp_servers.jenkins-config]` + `command = "npx"` + `args = ["-y", "@zythegit/jenkins-config-mcp"]`
- pi：`{ "command": "npx", "args": ["-y", "@zythegit/jenkins-config-mcp"] }`（无 `type`）


## 两个坑

Windows 上 `command: "npx"` 可能起不来：部分客户端不经 shell 直接 spawn，而 `npx.cmd` 不是可执行文件。启动失败就把 `command` 换成 `cmd`、`args` 前面补 `/c` 重新 add（同名 upsert，直接覆盖旧声明）：

```powershell
'{"name":"jenkins-config","transport":"stdio","command":"cmd","args":["/c","npx","-y","@zythegit/jenkins-config-mcp"]}' |
  aforge mcp add --from-json
```

`headers` / `env` 里的 token 会明文落在 `profile.yaml` 和投影出的配置文件里——项目层 SoT 通常进 git，敏感凭据建议放用户层（`--scope user`）或改用环境变量间接引用。

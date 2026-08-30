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

## 两个坑

Windows 上 `command: "npx"` 可能起不来：部分客户端不经 shell 直接 spawn，而 `npx.cmd` 不是可执行文件。启动失败就把 `command` 换成 `cmd`、`args` 前面补 `/c` 重新 add（同名 upsert，直接覆盖旧声明）：

```powershell
'{"name":"jenkins-config","transport":"stdio","command":"cmd","args":["/c","npx","-y","@zythegit/jenkins-config-mcp"]}' |
  aforge mcp add --from-json
```

`headers` / `env` 里的 token 会明文落在 `profile.yaml` 和投影出的配置文件里——项目层 SoT 通常进 git，敏感凭据建议放用户层（`--scope user`）或改用环境变量间接引用。

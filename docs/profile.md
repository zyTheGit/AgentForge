# profile.yaml 配置参考

`profile.yaml` 是 SoT 的「开关面板」：投影到哪几个 Agent、用哪些模板、MCP 服务器、技能策略、两层合并方式、投影细节。规格定义见 [Spec §4.2](../AgentForge-Spec.md#42-profileyaml)，schema 的唯一事实源是 `src/schema/profile.ts`。

## 文件位置与两层装配

- 用户级：`%USERPROFILE%\.agentforge\profile.yaml`（可用 `AGF_HOME` 改根）
- 项目级：`<项目根>\.agentforge\profile.yaml`

每次命令执行时两层都会被加载，按 `merge` 声明合并，再填充 schema 默认值。优先级（高 → 低）：

```
环境变量（AGF_LINE_ENDING / AGF_SCOPE） > project 层文件 > user 层文件 > 内置默认
```

合并选项本身取**更高层级**（project 层）的 `merge` 声明；两层都没写才用默认 `overlay` + `replace`。两层都不存在时装配退回内置默认（等价 `aforge init --yes` 写下的那份）。

配置损坏（YAML 语法错误或校验失败）时命令直接失败并列出出错字段路径，退出码 2 —— 不会静默降级到默认值。

## 最小可用配置

`targets` 是唯一必填字段，其余全部可省略：

```yaml
version: 1
targets: [opencode]
```

`aforge init` 写下的默认（Spec §4.2「Windows 安装默认值」）：

```yaml
version: 1
scope: project
targets: [opencode, codex, claude, pi]
templates: [base/default]
skills:
  copy_mode: copy
projection:
  marker_mode: replace_between_markers
  line_ending: lf
learning:
  default_scope: project
  auto_promote: false
```

## 顶层字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | `1` | `1` | schema 版本，目前只接受 `1` |
| `scope` | `user` \| `project` | 无 | 仅声明本文件所属层级；实际有效 scope 由「哪一层在用」推导（`AGF_SCOPE` 可强制），合并后该字段无意义 |
| `targets` | `(opencode\|codex\|claude\|pi)[]` | **必填**，至少一项 | 投影目标。**选择型数组**：合并时 project 层恒覆盖 user 层，不受 `merge.arrays` 影响 |
| `templates` | `string[]` | 无（渲染层兜底 `base/default`） | 模板 id 列表，内容型数组，参与 `merge.arrays`。解析优先级与自定义写法见 [规则正文装配](rules.md) |
| `extensions` | object | `{}` | 用户自定义扩展键，原样透传、不校验内部结构 |

给 `targets` 默认值会伪造用户选择，所以它是唯一的必填项；`templates` / `mcp.servers` / `skills.*` 都是内容型数组，缺省即「未设置」，好让两层继承能区分「显式空数组」和「没写」。

`targets` 的取值域分两层，各有**一个**事实源，代码里也确实只有这一份：

- **运行时可用集合** = projector 注册表（`src/core/project/projectors/registry.ts`）。`aforge sync --targets` 的合法性校验每次现读注册表内容（不再对照另写一份常量），因此运行时新注册的 projector 会立刻被 `--targets` 认下。
- **`profile.yaml` 的取值域** = 内置 id 元组（`src/core/project/target-ids.ts`）。`schema/profile.ts` 的 `TargetEnum` 与注册表的装配表都从这个叶子模块取同一份元组（叶子模块零 import，避免 `schema/profile → registry` 成环），所以加内置 projector 时漏改一处即编译失败。

注意 `profile.yaml` 这一侧目前仍**只接受四个内置 id**：运行时后补注册的第三方 target 能被 `aforge sync --targets` 认下，却**写不进本文件**（schema 的枚举只认内置元组）。放开这一层取决于外部/声明式适配器的加载方案，收在 issue [#53](https://github.com/zyTheGit/AgentForge/issues/53)（[路线图](roadmap.md#phase-3已完成)「适配器插件化」的第二层）。

`templates` 里能填哪些 id，取决于 user 层 `sources.json` 中登记且**已启用**的源（`sources.json` 与 `store\` 恒在 user 层）。`aforge init` 默认注册的官方模板源是**禁用**态，启用方式、pin 策略与离线行为见 [命令速查](commands.md#官方模板源默认注册默认禁用)。

## mcp

```yaml
mcp:
  servers:
    - name: everything-search
      transport: stdio
      command: npx
      args: ['-y', 'mcp-server-everything-search']
      env: { EVERYTHING_SDK: 'C:\tools\Everything64.dll' }
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `servers[].name` | string | **必填** | 非空；`aforge mcp add` 按 name upsert |
| `servers[].transport` | `stdio` \| `http` \| `sse` | **必填** | |
| `servers[].enabled` | boolean | `true` | `false` 时不翻译进各 Agent 的原生配置 |
| `servers[].command` / `args` | string / string[] | 无 | `stdio` 用 |
| `servers[].url` / `headers` | string / `{string: string}` | 无 | `http` / `sse` 用；url 不做格式校验 |
| `servers[].env` | `{string: string}` | 无 | **值必须是字符串**，写数字会校验失败（`PORT: '8080'`） |

字段与 `transport` 的搭配（stdio 要 command、http/sse 要 url）由 MCP 管理层校验，不在 schema 里。`servers` 数组**整组参与合并**，不对元素做深合并——project 层重写某个 server 要把该元素写全。凭据以明文存放，注意见 [MCP](mcp.md)。

## skills

```yaml
skills:
  always: [code-review, daily-report]
  expose_as_command: [code-review]
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `always` | string[] | 无 | 每次 `sync` 都物化并投影的技能名。`aforge skill add` 会自动幂等登记（`--no-register` 关闭），`skill remove` 只把名字摘掉 |
| `on_demand` | string[] | 无 | **按需装载**：正文照常物化投影，但不进模型的自动路由清单（claude / pi 注入 frontmatter `disable-model-invocation: true`，codex 额外写 sidecar `agents\openai.yaml`，opencode 无对应开关）。点名却没装**不阻塞** `sync`（只 warn）；**与 `always` 有交集则加载即失败**（退出码 2，两张名单语义互斥）。见 [技能](skills.md#按需装载on_demand) |
| `copy_mode` | `copy` \| `symlink` | `copy` | **`symlink` 恒被忽略且不予实现**；enum 保留取值只为不让既有 profile 加载失败，声明它会让 `doctor` 报 `skills-copy-mode` warn |
| `expose_as_command` | string[] | 无 | 额外投影成命令/prompt 薄壳的技能名，可带 `ns/` 前缀。**必须是 `always` 的子集**（最后一段是技能名），点名却没登记 → `sync` 退出码 2 |

`skill add` / `skill remove` 的回写会重排整份 `profile.yaml` 并**丢弃注释**，别把重要说明只写在这个文件的注释里。落点、调用前缀、`$1..$9` 位置参数见 [技能](skills.md)。

## merge

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `strategy` | `overlay` \| `replace` | `overlay` | `overlay` 深合并（project 覆盖 user 同名字段，未定义的继承）；`replace` 让 project 整份替代 user |
| `arrays` | `append` \| `replace` | `replace` | `append` 把 project 数组接在 user 数组后；`replace` 完全替代 |

陷阱：`merge.arrays: replace`（默认）下，project 层写 `skills: { always: [] }` 会把 user 层的技能清单整份清空，而不是「不改」。想保留就别写这个键。`targets` 不受本项控制，恒由 project 覆盖。

## projection

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `write_agents_md` | boolean | 未设置（视为 true） | `false` → opencode / codex / pi 不再写根 `AGENTS.md` |
| `write_claude_md` | boolean | 未设置（视为 true） | `false` → claude 不写 `CLAUDE.md`；显式 `true` 额外启用 opencode 的**可选** `CLAUDE.md`（§8.7 矩阵里标「可选」的那项） |
| `marker_mode` | `none` \| `append_below_marker` \| `replace_between_markers` | `replace_between_markers` | 见下 |
| `marker_begin` | string | `<!-- BEGIN AGENTFORGE -->` | 与 `core/markers` 常量同源 |
| `marker_end` | string | `<!-- END AGENTFORGE -->` | |
| `line_ending` | `lf` \| `crlf` | `lf` | Windows 亦默认 LF；`AGF_LINE_ENDING` 可覆盖 |
| `path_style` | `auto` \| `windows` \| `posix` | `auto` | 投影正文里路径 token 的分隔符与家目录变量：`windows` 用 `\` + `%USERPROFILE%`，`posix` 用 `/` + `$HOME`。只作用于被识别为路径的片段，散文里的斜杠（`pnpm/bun`）不受影响 |
| `gitignore_generated` | boolean | 未设置（视为 false） | 显式 `true` 且有效 scope 为 `project` 时，`sync` 成功后把项目根内的投影产物写进 `.gitignore` 的 `# BEGIN AGENTFORGE` 标记段（段内全量重算 → 幂等） |

`marker_mode` 三档：

- `replace_between_markers`（默认）：只替换 marker 区间，区间外手写内容原样保留；区间被手工改过 → `sync` 报冲突，退出码 3，`--force` 可覆盖。
- `append_below_marker`：新正文插到 `marker_begin` 之后，旧内容留在下方；同一正文已存在时跳过追加，重复 `sync` 幂等。
- `none`：不用 marker 包裹，主规则文件降级为整文件写入——**marker 外的手写内容会被覆盖**，冲突预检查与 `--force` 对该模式无意义。

## learning

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `default_scope` | `user` \| `project` | `project` | `aforge learn` 默认落哪一层 |
| `auto_capture` | `off` \| `prompt` \| `hook` | `off` | `off` 只有人工敲命令；`prompt` 在投影正文加一段 `## Learning Protocol` 指示 agent 自行调用 `aforge learn`（概率性）；`hook` 改由 target 的 `SessionStart` 钩子注入同一段协议（与 `prompt` 互斥，**只有 codex 支持**，其余三家等同 `off` 并显式提示，见 [learning](learning.md#支持矩阵)） |
| `auto_promote` | boolean | `false` | 条目产生后是否顺手 promote。与 `auto_capture` 正交，两者都开也仍不直接投影 |
| `include_promoted_in_sync` | boolean | `true` | `false` → `sync` 不把已 promote 的条目注入投影正文 |

闭环细节见 [learning](learning.md)。

## 校验与编辑器提示

- `npm run emit-schema` 生成的 `schemas/profile.schema.json`（JSON Schema Draft 2020-12，`$id: https://agentforge.dev/schema/profile.json`）可挂到编辑器做补全与校验。
- `aforge doctor` 会检出「声明了却无效」的字段（`copy_mode: symlink`、`on_demand` 的名字没装 / frontmatter 无处注入、命令命名空间被平铺、`auto_capture: hook` 下没有钩子落点的 target 等），这些是 warn，不影响退出码。
- 尚未实现或被平台限制的字段汇总见 [平台注意事项与已知限制](platform.md#已知限制)。

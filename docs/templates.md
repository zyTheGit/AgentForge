# templates/ 模板

模板是规则正文的第 ③ 层。与 [custom/](custom-rules.md) 的区别只有一个：**模板走 Handlebars 渲染，能读 `habits.yaml` 的值**。不需要变量的内容放 custom/ 更省事。装配顺序见 [规则正文装配](rules.md)。

## 登记与文件位置

模板必须在 `profile.yaml` 的 `templates` 数组里登记才会被渲染，写在目录里但没登记 = 不生效。

```yaml
templates: [base/default, my/testing]
```

id 到文件的映射是 `<SoT 根>\templates\<id>.md`——id 不含扩展名，`/` 是路径分隔符，**子目录任意深度都可以**（与 custom/ 相反）。上例 `my/testing` → `.agentforge\templates\my\testing.md`。

id 校验（`src/core/generate/resolver.ts` 的 `validateTemplateId`）拒绝空串、含反斜杠 `\`、绝对路径、以及任何空段 / `.` / `..` 段，违规直接 `ConfigError` 退出码 2。

`aforge template enable/disable <id>` **只改 `profile.templates` 数组**，不动文件；`aforge template list` 列出 builtin + 两层 SoT + 各启用源的全部可用 id（同 id 多处存在会逐条列出并标 origin）。

## 查找优先级

同一个 id 按这个顺序取第一个命中（`resolveTemplate`）：

1. **内置模板**（发行包只读骨架：`base/default` / `base/tools` / `base/context`）
2. 项目层 `<项目根>\.agentforge\templates\<id>.md`
3. 用户层 `%USERPROFILE%\.agentforge\templates\<id>.md`
4. **已登记且已启用**的源：`<源根>\templates\<id>.md`（git 源的源根是 `%USERPROFILE%\.agentforge\store\<源 id>`，local 源是登记的 `path`），多个源命中时按源 id 字典序取首个

四处都没有 → `ConfigError` 退出码 2，message `未解析的模板 id: <id>`，hint 指向 `aforge template list`。

若该 id 只存在于**已禁用**的源里，报的是 `模板 id 只存在于已禁用的源: <id>（来自 <源 id>）`，hint 给出 `aforge source enable <源 id>` 与 `aforge template disable <id>` 两条修复动作。第 4 层只认 `sources.json` 里 `enabled` 的条目：`source disable` 之后缓存留着但不参与渲染，未登记的孤儿 `store\` 目录同样不参与。

## 三个内置模板

登记表是 `src/assets/templates.ts` 的 `BUILTIN_TEMPLATES`（Spec §5.1，**数量封顶 3 个**）：

- **`base/default`** —— **恒渲染**（第 ④ 层）。骨架 + Toolchain / Style / Verification / Forbidden。
- **`base/tools`** —— **opt-in**。渲染 `tools.shell` / `editor` / `container` / `git.*`，输出 `## Tools` 节。
- **`base/context`** —— **opt-in**。把 `habits.detected` 渲染成 `## Project Context (detected)` 节，首句明写「for reference only — not rules」；`manager: none` 的条目整条省略。

opt-in 的两个要登记才生效：`aforge template enable base/tools`（或手工加进 `profile.templates`）→ `aforge sync`。**`init` 不会自动追加它们**，默认投影保持极薄。它们与外部模板同层（第 ③ 层），所以按数组顺序出现在 `base/default` **之前**。

```yaml
templates: [base/tools, base/context, base/default]
```

**三个都不可覆盖。** 它们在第 1 步短路返回内置常量，在 `templates/base/*.md` 放同名文件**没有任何效果**（仓库根的 `templates/base/` 只是 `src/assets/templates.ts` 的同步副本，由单测锁定逐字一致，不参与运行时查找）。想改内置那套说法，只能换个 id（如 `my/base`）登记进 `profile.templates`——它会渲染在内置模板**之前**。

## 模板里能用什么

数据只有 `habits.yaml` 投影出来的四个顶层键（`composer.ts` 的 `TemplateView`）：

```
runtime.node.{manager,version,notes}      runtime.python.{manager,version,notes}
runtime.package_managers                  runtime.rust.{manager,toolchain}
runtime.go.{manager,version}              runtime.has_toolchain   ← 派生布尔
tools.shell   tools.editor   tools.container   tools.has_any   ← 派生布尔
tools.git.{conventional_commits,sign_commits,default_branch,notes}
ai.language   ai.style   ai.verification   ai.forbid
detected.runtimes[].{label,manager,version,source}                ← habits.detected 收窄
detected.package_managers   detected.monorepo   detected.ci   detected.has_any
```

字段的取值域与声明写法见 [habits.yaml 配置参考](habits.md)——那里是声明侧的单一事实源，本页只讲模板视角。

**访问不到**：`profile.*`、`habits.notes`、`habits.extensions`、learnings、custom 内容、以及任何**现场**环境信息（OS / 环境变量 / CI）。环境信息是**刻意**排除的——正文必须与环境无关，否则同一份 SoT 在 CI 与本机渲染出的 `contentHash` 会漂移，`doctor` 的一致性比对就开始误报。

`detected.*` 不违反这条：它读的是 `habits.yaml` 里**已落盘**的探测快照（`aforge init` / `aforge detect` 写入），跨环境字节一致；快照变了本身就是一次显式的 SoT 变更。收窄规则在 `src/core/generate/detected-view.ts`：只认白名单键（node / python / java / dotnet / rust / go / package_managers / monorepo / ci），类型不符或 `manager: none` 的条目静默省略，**不抛错**——一段参考信息不该把 `sync` 拖挂。

`ai.language` 是三个内置模板都不渲染的字段，需要它就得写自定义模板（`tools.*` 已有 `base/tools` 兜底）。

几个影响 `#if` 判断的归一化：`manager` 未声明或为 `none` 的 runtime 条目整条变 undefined；空数组变 undefined；`tools.container: none` 变 undefined。所以模板里 `{{#if runtime.node}}` 与 `{{#if runtime.node.manager}}` 效果相同。

## 引擎约束

渲染层是 `src/core/generate/renderer.ts`：

- **只有内置 helper**：`#if` / `#unless` / `#each`（含 `{{else}}`、`@first` / `@last`）。**不注册任何自定义 helper，也不支持 partial**（`{{> foo}}`）——这类写法能通过语法校验，但渲染时抛错 → `ConfigError(2)` `模板渲染失败：…`；
- **HTML 转义关闭**（`noEscape: true`）。输出是 Markdown，`<path>` / `**bold**` 原样保留，`{{{ }}}` 与 `{{ }}` 等价；
- 语法错误在渲染前由 `validateTemplate` 拦下 → `ConfigError(2)`，message 带 Handlebars 的行号；
- 渲染结果会剥掉首部空行与尾部空白、统一单个 `\n` 结尾——这是「同输入两次渲染字节一致」的前提，也是 `contentHash` 稳定的基础。

## 写模板的两条硬约束

来自 Spec §5.1 / §4.1，内置 `base/default` 严格遵守，自定义模板也该照做：

1. **字段为空就省略整个小节**，用 `#if` 包起来。不要输出 `Not specified`、不要编造默认工具名——空着比猜错好。
2. **不写死个人工具名**。工具名只能从变量注入，否则模板就不能在别人机器上复用，也失去了 `habits.yaml` 作为唯一声明源的意义。

## 一个例子

`.agentforge\templates\my\workflow.md`，把 `tools` 按自己的措辞渲染出来（只想要默认措辞的话，直接 `aforge template enable base/tools` 就够了）：

```handlebars
{{#if tools.shell}}

## Shell
命令示例一律按 **{{tools.shell}}** 语法给出。
{{/if}}
{{#if tools.git}}

## Git
{{#if tools.git.conventional_commits}}
- commit message 用 Conventional Commits 前缀。
{{/if}}
{{#if tools.git.default_branch}}
- 主分支是 `{{tools.git.default_branch}}`，改动走分支 + PR。
{{/if}}
{{/if}}
```

然后 `aforge template enable my/workflow`（或手工加进 `profile.templates`）→ `aforge sync`。

编码、换行与路径归一化见 [规则正文装配](rules.md#编码换行与路径)。

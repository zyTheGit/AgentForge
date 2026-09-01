# 规则正文装配：custom/ 与 templates/

投影到各 Agent 的规则正文不是某一个文件的拷贝，而是四层素材按固定顺序拼出来的。`habits.yaml` 只喂第 ④ 层的变量，想写「模板变量表达不了的话」就得用 `custom/`（逐字插入）或 `templates/`（自定义 Handlebars 模板）。规格定义见 Spec §5.1–§5.4，装配实现的事实源是 `src/core/generate/composer.ts`。

## 四层装配顺序

`composeRules`（`src/core/generate/composer.ts:291`）自上而下产出：

```
① custom/*.md                    两层合并、文件名序、逐字插入
①′ ## Learning Protocol          仅 learning.auto_capture: prompt
② ## Learnings                   已 promote 的 learning 条目
②′ ## Notes                      habits.notes
③ profile.templates 里的模板      按数组顺序，Handlebars 渲染
④ 内置 base/default              恒渲染一次，最低层
```

小节间以空行连接，出口统一按 `profile.projection.path_style` 归一路径 token，再交给投影层用 marker 包裹。**「顺序在前」就是优先级高**——LLM 读到前面的内容更容易生效，但没有任何机制让 ① 覆盖 ④，四层是**叠加**关系而不是覆盖关系。想让某条约定压过内置模板的说法，靠的是它出现得更早、说得更具体。

全部四层都空 → 正文为空串。

## custom/：逐字插入的手写规则

```
%USERPROFILE%\.agentforge\custom\*.md     用户级
<项目根>\.agentforge\custom\*.md          项目级
```

放进去就生效，不需要在 `profile.yaml` 里登记。规则（`src/core/project/sync-prepare.ts:83`）：

- 只收**直接子项**里的 `.md` 文件——**子目录不递归**，`custom/team/rules.md` 不会被读到；
- 后缀大小写敏感，`.MD` 不收；
- **两层都参与**，同名文件 project 层覆盖 user 层；最终按文件名统一排序输出（不是「user 全部在前」）；
- 排序是 JS 默认的码位序，大写字母排在小写前（`Zz.md` 在 `aa.md` 之前）。想控制顺序就用数字前缀：`10-style.md` / `20-testing.md`；
- **内容逐字插入，不走 Handlebars**——写 `{{runtime.node.manager}}` 会原样出现在投影正文里；
- 目录不存在、不可读，或单个文件读失败，都静默跳过，不阻塞 `sync`。

`aforge promote <id> --to custom_rule` 会往这里写 `<learning-id>.md`；`aforge import` 把认不出来的内容块写成 `imported-<时间戳>.md`。

**什么时候用 custom/**：项目特有的约定、`habits.yaml` 枚举装不下的具体命令、需要整段散文表达的东西。比如本仓库 `AGENTS.md` 里那段「改动走分支 + PR，不直推 main」就属于 custom/ 的典型内容——`ai.forbid` 只能塞一行短句，讲不清 bypass 记录这回事。

## templates/：自定义模板

模板与 custom/ 的区别只有一个：**模板走 Handlebars 渲染，能读 `habits.yaml` 的值**。不需要变量的内容放 custom/ 更省事。

### 登记与文件位置

模板必须在 `profile.yaml` 的 `templates` 数组里登记才会被渲染，写在目录里但没登记 = 不生效。

```yaml
templates: [base/default, my/testing]
```

id 到文件的映射是 `<SoT 根>\templates\<id>.md`——id 不含扩展名，`/` 是路径分隔符，**子目录任意深度都可以**（与 custom/ 相反）。上例 `my/testing` → `.agentforge\templates\my\testing.md`。

id 校验（`src/core/generate/resolver.ts:36`）拒绝空串、含反斜杠 `\`、绝对路径、以及任何空段 / `.` / `..` 段，违规直接 `ConfigError` 退出码 2。

### 查找优先级

同一个 id 按这个顺序取第一个命中（`src/core/generate/resolver.ts:89`）：

1. **内置 `base/default`**（发行包只读骨架）
2. 项目层 `<项目根>\.agentforge\templates\<id>.md`
3. 用户层 `%USERPROFILE%\.agentforge\templates\<id>.md`
4. 源 store `%USERPROFILE%\.agentforge\store\<源>\templates\<id>.md`，多个源命中时按源目录名字典序取首个

四处都没有 → `ConfigError` 退出码 2，message `未解析的模板 id: <id>`，hint 指向 `aforge template list`。

**`base/default` 不可覆盖。** 它在第 1 步就短路返回内置常量，在 `templates/base/default.md` 放同名文件**没有任何效果**（仓库根的 `templates/base/default.md` 只是 `src/assets/templates.ts` 的同步副本，由单测锁定逐字一致，不参与运行时查找）。想改内置那套说法，只能换个 id（如 `my/base`）登记进 `profile.templates`——它会渲染在内置模板**之前**。

`aforge template list` 列出 builtin + 两层 SoT + 各启用源的全部可用 id（同 id 多处存在会逐条列出并标 origin）；`aforge template enable/disable <id>` **只改 `profile.templates` 数组**，不动文件。

### 模板里能用什么

数据只有 `habits.yaml` 投影出来的三个顶层键（`TemplateView`，`src/core/generate/composer.ts:96`）：

```
runtime.node.{manager,version,notes}      runtime.python.{manager,version,notes}
runtime.package_managers                  runtime.rust.{manager,toolchain}
runtime.go.{manager,version}              runtime.has_toolchain   ← 派生布尔
tools.shell   tools.editor   tools.container
tools.git.{conventional_commits,sign_commits,default_branch,notes}
ai.language   ai.style   ai.verification   ai.forbid
```

**访问不到**：`profile.*`、`habits.notes`、`habits.detected`、`habits.extensions`、learnings、custom 内容、以及任何环境信息（OS / 环境变量 / CI）。环境信息是**刻意**排除的——正文必须与环境无关，否则同一份 SoT 在 CI 与本机渲染出的 `contentHash` 会漂移，`doctor` 的一致性比对就开始误报。

`tools.*` 与 `ai.language` 是内置模板不渲染、但视图里有的字段——自定义模板的主要用途之一就是把它们渲染出来。

几个影响 `#if` 判断的归一化：`manager` 未声明或为 `none` 的 runtime 条目整条变 undefined；空数组变 undefined；`tools.container: none` 变 undefined。所以模板里 `{{#if runtime.node}}` 与 `{{#if runtime.node.manager}}` 效果相同。

### 引擎约束

渲染层是 `src/core/generate/renderer.ts`：

- **只有内置 helper**：`#if` / `#unless` / `#each`（含 `{{else}}`、`@first` / `@last`）。**不注册任何自定义 helper，也不支持 partial**（`{{> foo}}`）——这类写法能通过语法校验，但渲染时抛错 → `ConfigError(2)` `模板渲染失败：…`；
- **HTML 转义关闭**（`noEscape: true`）。输出是 Markdown，`<path>` / `**bold**` 原样保留，`{{{ }}}` 与 `{{ }}` 等价；
- 语法错误在渲染前由 `validateTemplate` 拦下 → `ConfigError(2)`，message 带 Handlebars 的行号；
- 渲染结果会剥掉首部空行与尾部空白、统一单个 `\n` 结尾——这是「同输入两次渲染字节一致」的前提，也是 `contentHash` 稳定的基础。

### 写模板的两条硬约束

来自 Spec §5.1 / §4.1，内置 `base/default` 严格遵守，自定义模板也该照做：

1. **字段为空就省略整个小节**，用 `#if` 包起来。不要输出 `Not specified`、不要编造默认工具名——空着比猜错好。
2. **不写死个人工具名**。工具名只能从变量注入，否则模板就不能在别人机器上复用，也失去了 `habits.yaml` 作为唯一声明源的意义。

### 一个例子

`.agentforge\templates\my\workflow.md`，把内置模板不管的 `tools` 渲染出来：

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

## 编码、换行与路径

对 custom/ 与 templates/ 都一样：

- **UTF-8**，读入时自动剥 UTF-8 BOM，写出无 BOM；
- 源文件用 CRLF 还是 LF 无所谓，落盘时统一按 `profile.projection.line_ending` 展开；`contentHash` 一律以 LF 规范化后计算，换行差异不会被判成内容变更；
- `projection.path_style` 在装配**出口**统一施加，**四层素材都受影响**——custom/ 里写的 `%USERPROFILE%\...` 会在 `posix` 风格下被改写成 `$HOME/...`。只改写被识别为路径的 token，散文里的斜杠（`pnpm/bun`）与 URL 不动；
- 文件大小与数量**没有上限**。

## 迁移与体检

`aforge bundle export` 会把 `custom/` 与 `templates/` **整棵目录**带走（`CARRY_DIRS`，与 `learnings` / `skills` / `mcp` 并列），内容不做任何净化改写。唯一的坑是 symlink：**一律不跟随**，会被记进 `skipped` 并给出 warning，换机器时静默丢失——这两个目录里别用 symlink。

`aforge status` 会统计 custom 文件数（同样只认直接子项 `.md`，所以放进子目录的文件在这里也数不到，可以用来交叉验证）。

## 相关文档

- 变量的来源与全字段：[habits.yaml 配置参考](habits.md)
- `templates` / `projection` / `marker_mode` 等开关：[profile.yaml 配置参考](profile.md)
- learning → custom 规则的闭环：[learning](learning.md)
- 外部模板包（`source add` 与 store 布局）：[命令速查](commands.md)

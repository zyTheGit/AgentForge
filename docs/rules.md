# 规则正文装配

投影到各 Agent 的规则正文不是某一个文件的拷贝，而是四层素材按固定顺序拼出来的。本页只讲**顺序与怎么选**，两个出口的写法各有专页：

- 逐字插入手写规则 → [custom/ 逐字规则](custom-rules.md)
- 用 `habits.yaml` 的值渲染 → [templates/ 模板](templates.md)

规格定义见 Spec §5.1–§5.4，装配实现的事实源是 `src/core/generate/composer.ts` 的 `composeRules`。

## 四层装配顺序

```
① custom/*.md                    两层合并、文件名序、逐字插入
①′ ## Learning Protocol          仅 learning.auto_capture: prompt
② ## Learnings                   已 promote 的 learning 条目
②′ ## Notes                      habits.notes
③ profile.templates 里的模板      按数组顺序，Handlebars 渲染（含 opt-in 的内置模板）
④ 内置 base/default              恒渲染一次，最低层
```

小节间以空行连接，出口统一按 `profile.projection.path_style` 归一路径 token，再交给投影层用 marker 包裹。

**「顺序在前」就是优先级高**——LLM 读到前面的内容更容易生效，但没有任何机制让 ① 覆盖 ④，四层是**叠加**关系而不是覆盖关系。想让某条约定压过内置模板的说法，靠的是它出现得更早、说得更具体。

全部四层都空 → 正文为空串。

## custom/ 还是 templates/

| | [custom/](custom-rules.md) | [templates/](templates.md) |
| --- | --- | --- |
| 内容 | 逐字插入，`{{...}}` 原样输出 | Handlebars 渲染，能读 `habits.yaml` 的值 |
| 生效方式 | 放进目录就生效 | 必须登记进 `profile.templates` |
| 装配层 | ① 最上层 | ③ 内置 `base/default` 之前 |
| 适合 | 项目特有约定、整段散文、枚举装不下的具体命令 | 需要按声明值变化的措辞、想跨机器复用的模板 |

不需要变量就用 custom/，省一次登记。

## 编码、换行与路径

对 custom/ 与 templates/ 都一样：

- **UTF-8**，读入时自动剥 UTF-8 BOM，写出无 BOM；
- 源文件用 CRLF 还是 LF 无所谓，落盘时统一按 `profile.projection.line_ending` 展开；`contentHash` 一律以 LF 规范化后计算，换行差异不会被判成内容变更；
- `projection.path_style` 在装配**出口**统一施加，**四层素材都受影响**——custom/ 里写的 `%USERPROFILE%\...` 会在 `posix` 风格下被改写成 `$HOME/...`。只改写被识别为路径的 token，散文里的斜杠（`pnpm/bun`）与 URL 不动；
- 文件大小与数量**没有上限**。

## 迁移与体检

`aforge bundle export` 会把 `custom/` 与 `templates/` **整棵目录**带走（`CARRY_DIRS`，与 `learnings` / `skills` / `mcp` 并列），内容不做任何净化改写。唯一的坑是 symlink：**一律不跟随**，会被记进 `skipped` 并给出 warning，换机器时静默丢失——这两个目录里别用 symlink。

`aforge status` 会统计 custom 文件数（只认直接子项 `.md`）。

## 相关文档

- 变量的来源与全字段：[habits.yaml 配置参考](habits.md)
- `templates` / `projection` / `marker_mode` 等开关：[profile.yaml 配置参考](profile.md)
- learning → custom 规则的闭环：[learning](learning.md)
- 外部模板包（`source add` 与 store 布局）：[命令速查](commands.md)

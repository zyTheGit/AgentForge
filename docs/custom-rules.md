# custom/ 逐字规则

`custom/*.md` 是规则正文的第 ① 层：**内容原样进投影**，不走渲染、不需要登记。装配顺序与另一个出口的对比见 [规则正文装配](rules.md)。

```
%USERPROFILE%\.agentforge\custom\*.md     用户级
<项目根>\.agentforge\custom\*.md          项目级
```

## 收录规则

实现在 `src/core/project/sync-prepare.ts` 的 `readCustomContents`：

- 只收**直接子项**里的 `.md` 文件——**子目录不递归**，`custom/team/rules.md` 不会被读到；
- 后缀大小写敏感，`.MD` 不收；
- **两层都参与**，同名文件 project 层覆盖 user 层；最终按文件名统一排序输出（不是「user 全部在前」）；
- 排序是 JS 默认的码位序，大写字母排在小写前（`Zz.md` 在 `aa.md` 之前）。想控制顺序就用数字前缀：`10-style.md` / `20-testing.md`；
- **内容逐字插入，不走 Handlebars**——写 `{{runtime.node.manager}}` 会原样出现在投影正文里；
- 目录不存在、不可读，或单个文件读失败，都静默跳过，不阻塞 `sync`。

编码、换行与路径归一化对 custom/ 与 templates/ 一致，见 [规则正文装配](rules.md#编码换行与路径)。

## 什么时候用

项目特有的约定、`habits.yaml` 枚举装不下的具体命令、需要整段散文表达的东西。

比如本仓库 `AGENTS.md` 里那段「改动走分支 + PR，不直推 main」就属于 custom/ 的典型内容——`ai.forbid` 只能塞一行短句，讲不清 bypass 记录这回事。

需要按 `habits.yaml` 的值变化的措辞则应写成模板，见 [templates/ 模板](templates.md)。

## 谁会往这里写

- `aforge promote <id> --to custom_rule` → `<learning-id>.md`
- `aforge import` 把认不出来的内容块写成 `imported-<时间戳>.md`
- `aforge status` 统计的 custom 文件数同样只认直接子项 `.md`，可以用来交叉验证收录情况

<!-- BEGIN AGENTFORGE -->
# AgentForge Rules
<!-- END AGENTFORGE -->

<!-- 以下内容在 marker 区间之外，`aforge sync` 不会覆盖（Spec §8.2） -->

## 代码组织

- `src/` 下单个 `.ts` 文件不得超过 **500 行**，由 `npm run lint:size` 卡口（详见 Spec §11.3）。
- 写新代码前先想清楚它属于哪个模块；文件接近上限就按职责拆，不要靠压缩注释腾空间。
- 判断"离上限还有多远"只认卡口自己的口径：`npm run lint` 会把 >= 450 行的文件打成 warn，`node scripts/check-file-size.mjs --report 10` 打印行数 Top 10。不要用 `Get-Content | Measure-Object -Line` 等**不计空行**的口径估算。

## 协作流程

- **改动走分支 + PR，不直推 `main`。** 远端 `main` 配了分支保护「Changes must be made through a pull request」；仓库所有者有 bypass 权限，直推**能成功但会留 bypass 记录**，等于绕过评审。正确流程：
  1. `git checkout -b <类型>/<简述>`（类型同 commit 前缀：`feat` / `fix` / `refactor` / `docs`）
  2. `git push -u origin <分支>`
  3. `gh pr create`
- 例外只有一种：用户在当次对话里**明确要求**直推 `main`。此时照做，但要在事后告知产生了 bypass 记录。
- 提交前先跑 `npm run typecheck && npm run lint && npm test`，三项全绿再提交。

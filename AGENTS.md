<!-- BEGIN AGENTFORGE -->
# AgentForge Rules
<!-- END AGENTFORGE -->

<!-- 以下内容在 marker 区间之外，`aforge sync` 不会覆盖（Spec §8.2） -->

## 代码组织

- `src/` 下单个 `.ts` 文件不得超过 **500 行**，由 `npm run lint:size` 卡口（详见 Spec §11.3）。
- 写新代码前先想清楚它属于哪个模块；文件接近上限就按职责拆，不要靠压缩注释腾空间。

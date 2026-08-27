/**
 * SoT YAML 文档的**序列化事实源**：habits.yaml / profile.yaml / learnings\*.yaml
 * 与 promote 产物，全部经 serializeYamlDoc 落盘。
 *
 * 为什么必须只有一处：`lineWidth: 0` 不是格式偏好而是**正确性约束**——默认的 80
 * 列折行会把长 content（learning 正文、custom 规则、mcp 参数）改写成多行折叠标量，
 * 往返读回后字符串已不是写入时那一份。补尾换行同理，缺了就每次 diff 都带
 * "\ No newline at end of file"。这两个参数原先靠 10 个调用点人工复制维持，
 * 任一处漏抄都不会被 tsc 或测试抓到（YAML 仍然合法，只是内容被折过）。
 *
 * 为什么放在 core/config 而不是 infra/fsutil 旁：受这条约束的全是 SoT 配置文档，
 * 调用方（commands/init-*、commands/import、core/learning、core/config 自身）都已
 * 依赖或可无环依赖 core/config；而 infra/fsutil 被 markers / writer / sync-* 等
 * 纯文本与投影路径大量 import，把 yaml 解析器塞进去会让这些从不写 YAML 的模块
 * 白拖一份依赖。本模块只 import `yaml` 与 infra/fsutil，是所有调用方的公共下游。
 */
import { stringify as stringifyYaml } from 'yaml';
import { ensureTrailingNewline } from '../../infra/fsutil';

/**
 * SoT YAML 文档 → 落盘文本（`lineWidth: 0` 禁折行 + 补尾换行）。
 *
 * @param value 已构造好的文档对象（本函数不做 schema 校验——校验是调用方的事，
 *   见 editProfile 的 assertValidProfile / LearningSchema.parse）。
 */
export function serializeYamlDoc(value: unknown): string {
  return ensureTrailingNewline(stringifyYaml(value, { lineWidth: 0 }));
}

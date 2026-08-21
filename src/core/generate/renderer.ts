/**
 * Handlebars 模板渲染（Spec §5.4）：语法校验 + noEscape 渲染，纯计算无 IO。
 *
 * - handlebars 经动态 import 惰性加载（Node / vitest 的 CJS 互操作把模块实体
 *   挂在 default 上，见 loadHandlebars）；
 * - 不注册任何自定义 helper（Spec §5.4：模板仅使用内置 helpers 与变量）；
 * - compile noEscape: 输出为 Markdown，`<path>` / `**bold**` 等不做 HTML 转义；
 * - 渲染结果规范化：剥首部空行与尾部全部空白，非空时统一单个 \n 结尾——
 *   这是"同输入两次渲染输出完全一致"（幂等）的前提；
 * - 语法错误 → ConfigError(2)（Spec §6.1 模板语法错误），Handlebars 的解析
 *   错误 message 自带行列位置（"Parse error on line N: …"）。
 */
import { ConfigError } from '../errors';

/** handlebars 模块形态（CJS `export =` 单实体，types/index.d.ts）。 */
type HandlebarsModule = typeof import('handlebars');

/** 动态加载 handlebars：运行时 default 属性上才是模块实体（CJS 互操作）。 */
async function loadHandlebars(): Promise<HandlebarsModule> {
  const mod: unknown = await import('handlebars');
  const candidate = mod as { default?: unknown };
  return (candidate.default ?? mod) as HandlebarsModule;
}

/** 从任意抛出值提取可读 message。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 模板语法校验（Handlebars.parse AST 解析）。
 *
 * @param source 模板正文
 * @param label 错误信息中的模板标识（如模板 id），缺省为 "模板"
 * @throws ConfigError(2) 语法非法（message 含解析错误位置与原文摘录）
 */
export async function validateTemplate(source: string, label = '模板'): Promise<void> {
  const Handlebars = await loadHandlebars();
  try {
    Handlebars.parse(source);
  } catch (err) {
    throw new ConfigError(`${label}语法错误：${errorMessage(err)}`, {
      hint: '检查模板中 Handlebars 表达式：{{#if}}/{{#each}}/{{#unless}} 需成对闭合标签，变量形如 {{path.to.value}}',
      details: { error: err },
    });
  }
}

/** 渲染结果规范化：剥首部空行与尾部全部空白；非空统一单个 \n 结尾。 */
function normalizeRendered(rendered: string): string {
  const stripped = rendered
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/\s+$/, '');
  return stripped === '' ? '' : `${stripped}\n`;
}

/**
 * 渲染模板：noEscape（Markdown 不转义）+ 输出规范化。
 *
 * 数据中 undefined / null / 空数组在 #if 下自然为 falsy——小节被省略，
 * 不会输出 "Not specified"（Spec §5.1，语义由调用方数据保证，本层不干预）。
 *
 * @throws ConfigError(2) compile 阶段发现语法错误（主路径已由 validateTemplate 覆盖）
 */
export async function renderTemplate(source: string, data: unknown): Promise<string> {
  const Handlebars = await loadHandlebars();
  try {
    const template = Handlebars.compile(source, { noEscape: true });
    return normalizeRendered(template(data));
  } catch (err) {
    throw new ConfigError(`模板渲染失败：${errorMessage(err)}`, {
      hint: '检查模板中 Handlebars 表达式的闭合与变量路径（{{path.to.value}}）',
      details: { error: err },
    });
  }
}

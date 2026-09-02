/**
 * 声明式适配器的硬上限与变量白名单（issue #53 安全边界 2 / 4）。
 *
 * 单独成模块的理由：这些数字与名单同时被三处消费（模板校验、加载发现、doctor
 * 提示）并且会写进 docs/profile.md 与测试断言——散在各处就会出现「文档说 32、
 * 代码卡 16」这种不可能被编译器发现的漂移。
 *
 * 为什么要有上限：声明式适配器没有代码执行能力，但**有写盘能力**。一份声明
 * 一万个落点的 yaml 足以把 `aforge sync` 变成写盘炸弹（事务还要为每个落点做
 * 备份），所以产物数量与路径深度必须卡死。
 */

/** `adapters/` 目录名（user 层与 project 层同名）。 */
export const ADAPTERS_DIRNAME = 'adapters';

/** 单层最多加载多少个适配器文件（超出的按文件名序拒绝并记 `limit` 失败）。 */
export const ADAPTER_MAX_FILES_PER_LAYER = 16;

/** 单个适配器文件的正文字节上限（YAML 只描述路径与开关，不该有兆级正文）。 */
export const ADAPTER_MAX_FILE_BYTES = 64 * 1024;

/** 单个适配器**单次 plan** 的产物条数上限（超出 → ConfigError(2)）。 */
export const ADAPTER_MAX_PLAN_ITEMS = 256;

/**
 * 单个产物路径在根目录之下的最大段数（`{userHome}` 之后还能有几层）。
 *
 * 24 段足够表达任何真实客户端的落点（最深的内置落点是 5 段），同时挡掉
 * 「用 3000 段路径把 Windows 的 MAX_PATH / 长路径前缀逻辑撑爆」这类玩法。
 */
export const ADAPTER_MAX_PATH_DEPTH = 24;

/**
 * 允许出现在 `{env:NAME}` 里的环境变量名（**白名单**，大小写敏感）。
 *
 * 为什么要白名单变量名本身：`{env:PATH}` / `{env:TEMP}` / `{env:SYSTEMROOT}` 这类
 * 变量指向的目录与「某个 agent 的配置根」毫无关系，允许自由取值等于把落点交给
 * 环境。名单里的每一项都是**某个上游客户端自己**用来定位配置根的变量。
 *
 * 注意：过了白名单**不等于**过了 containment——变量指向的目录仍要经
 * core/adapters/containment 校验（UNC 一律拒，见那里的 JSDoc）。
 */
export const ADAPTER_ENV_WHITELIST = [
  'CODEX_HOME',
  'PI_CODING_AGENT_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

/** 白名单环境变量名的联合类型。 */
export type AdapterEnvName = (typeof ADAPTER_ENV_WHITELIST)[number];

/** 变量名是否在白名单内。 */
export function isWhitelistedEnvName(name: string): name is AdapterEnvName {
  return (ADAPTER_ENV_WHITELIST as readonly string[]).includes(name);
}

/**
 * 启用 project 层适配器的环境变量（严格匹配 `"1"`，与 AGF_OFFLINE 同口径）。
 *
 * 默认忽略 project 层：即便没有代码执行，project 层适配器也能声明「往
 * `~/.ssh/config` 写文件」——`git clone` 一个仓库不该获得往用户主目录任意位置
 * 写的能力。
 */
export const ADAPTER_ALLOW_PROJECT_ENV = 'AGF_ALLOW_PROJECT_ADAPTERS';

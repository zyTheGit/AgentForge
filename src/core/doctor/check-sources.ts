/**
 * 源登记表诊断（Spec §9 + §12 Phase 2 官方模板源）。
 *
 * 为什么单独成模块：这一项与其余检查的依赖面完全不同——它只读 `sources.json` 与
 * `store\` 的**存在性**，不需要 EffectiveConfig、不碰 projector、也不参与渲染。
 * 混进 check-config 会把 sources 的常量表（core/sources/official）拖进"三层配置装配"
 * 那一簇的 import 面里。
 *
 * ## 零网络与"永不把 doctor 判失败"
 *
 * 本模块**只做 fs 判存在性**，一条 git 命令都不发：doctor 是诊断工具，不该因为
 * 一个可选特性去联网（离线环境下会挂在 clone 上，CI 里没有凭证）。
 *
 * 级别一律 ok / warn，**从不 error**：官方源的任何状态都不影响 `sync` 的正确性
 * （禁用 → 不联网、不进 `template list`、不参与渲染；启用但没缓存 → 只是它的模板 id
 * 解析不到，那由 §9 第 5 条 `template/<id>` 那项负责报 error）。让本项抬高退出码，
 * 等于让"没启用官方源"这件正常状态把 CI 里的 `aforge doctor` 弄红。
 *
 * "禁用"的语义是**该源完全不参与**：渲染侧的模板解析第 4 层以 `sources.json` 的
 * `enabled` 为判据（core/sources/render-scope），缓存留着只是为了重新 enable 时不必
 * 再联网。若 `profile.templates` 引用了只存在于禁用源的模板 id，会由
 * `template/<id>` 那项报 error(2)（issue #55）。
 *
 * 登记表本身损坏（坏 JSON / 越界 id）也走 warn 并附原因：那条错误的正主是
 * `aforge source *` 命令（会以退出码 2 失败），这里只负责让用户在体检报告里看见它。
 */
import type { Host } from '../../infra/host';
import type { Source } from '../../schema';
import type { EnvSnapshot } from '../env';
import type { OsContext } from '../paths';
import {
  listSources,
  type SourceManagerContext,
  sourceStoreDir,
  sourcesFilePath,
} from '../sources/manager';
import { DEFAULT_SOURCES, type DefaultSourceDecl, findDefaultSource } from '../sources/official';
import { type DoctorCheckResult, errMessage } from './check-types';

/** doctor 侧的 source 上下文（cwd 只用于 local 源的相对路径解析，此处不涉及）。 */
function managerContextForDoctor(
  host: Host,
  env: EnvSnapshot,
  os: OsContext,
  cwd: string,
  userSoTRoot: string,
): SourceManagerContext {
  return { host, env, userSoTRoot, cwd, os };
}

/** 登记项与常量表声明的 url/ref 是否一致（不一致 = 用户改过 pin，不是错误）。 */
function pinMatchesDecl(source: Source, decl: DefaultSourceDecl): boolean {
  return source.type === 'git' && source.url === decl.url && source.ref === decl.ref;
}

/** 一条默认注册项的状态描述（登记 / 启用 / 是否已拉取 / pin）。 */
async function describeDefaultSource(
  mgr: SourceManagerContext,
  decl: DefaultSourceDecl,
  registered: Source | undefined,
): Promise<DoctorCheckResult> {
  const item = `sources/default/${decl.id}`;
  if (registered === undefined) {
    // 「未登记」是**常规态**：`init` 已不再播种（Spec §4.6），该源只在用户显式
    // `source enable` 时进登记表。所以这里不区分「登记表存不存在」——两种情况下用户的
    // 下一步动作完全一样，分开写只会让报告里多一句没有行动价值的话。
    return {
      section: 'config',
      level: 'ok',
      item,
      detail: `${decl.description}：未登记（init 不再播种该源，Spec §4.6 已决议裁剪，下一 major 移除）`,
      hint: `如需使用：aforge source enable ${decl.id}（会按内置声明补登记并启用，pin: ${decl.ref}）`,
    };
  }

  const pinNote = pinMatchesDecl(registered, decl)
    ? ''
    : '；登记的 url/ref 与内置声明不同（本机改写优先，升级 CLI 不会改动它）';
  const ref = registered.type === 'git' ? (registered.ref ?? '(none)') : '(local)';

  if (registered.enabled === false) {
    return {
      section: 'config',
      level: 'ok',
      item,
      detail: `${decl.description}：已登记、当前禁用（不联网、不进 template list、不参与渲染）；pin: ${ref}${pinNote}`,
      hint: `启用：aforge source enable ${decl.id}`,
    };
  }

  const storeDir = sourceStoreDir(mgr, decl.id);
  if (!(await mgr.host.exists(storeDir))) {
    return {
      section: 'config',
      level: 'warn',
      item,
      detail: `${decl.description}：已启用但尚未拉取内容（${storeDir} 不存在）；pin: ${ref}${pinNote}`,
      hint: `首次 aforge template list 会自动拉取；离线（AGF_OFFLINE=1）或 CI 下不自动拉，需显式 aforge source update ${decl.id}`,
    };
  }
  const commit = registered.type === 'git' ? (registered.commit ?? '') : '-';
  if (commit === '') {
    // 目录在、commit 没记 → 一次中途失败的 clone 留下的残留（内容是远端默认分支，
    // 与 pin 无关）。报 ok「缓存就绪」会让"渲染出来的规则不是 pin 的那份"永久隐形。
    return {
      section: 'config',
      level: 'warn',
      item,
      detail: `${decl.description}：缓存目录存在但未记录 commit（${storeDir}）——很可能是一次中途失败的拉取残留，内容未必是 pin 的那一份；pin: ${ref}${pinNote}`,
      hint: `执行 aforge source update ${decl.id} 重新落定 pin（下次 aforge template list 也会自动重拉）`,
    };
  }
  return {
    section: 'config',
    level: 'ok',
    item,
    detail: `${decl.description}：已启用、缓存就绪（${storeDir}）；pin: ${ref} @ ${commit}${pinNote}`,
  };
}

/**
 * 默认注册源（官方模板源）诊断项。
 *
 * @param userSoTRoot user 层 SoT 根；不可解析时传 undefined —— 此时整项降级为一条
 *        说明（`user-sot-root` 那条 error 已经报过根因，不重复计数）。
 */
export async function checkDefaultSources(
  host: Host,
  results: DoctorCheckResult[],
  env: EnvSnapshot,
  os: OsContext,
  cwd: string,
  userSoTRoot: string | undefined,
): Promise<void> {
  if (userSoTRoot === undefined) {
    results.push({
      section: 'config',
      level: 'ok',
      item: 'sources/default',
      detail: 'user 层 SoT 根不可解析，跳过官方源检查（根因见 user-sot-root）',
    });
    return;
  }

  const mgr = managerContextForDoctor(host, env, os, cwd, userSoTRoot);
  let sources: Source[];
  try {
    sources = await listSources(mgr);
  } catch (err) {
    results.push({
      section: 'config',
      level: 'warn',
      item: 'sources/registry',
      detail: `${sourcesFilePath(mgr)} 无法读取：${errMessage(err)}（aforge source 命令会以退出码 2 失败）`,
      hint: '按错误信息修正该文件；id 需匹配 ^[a-z0-9][a-z0-9_-]{1,63}$',
    });
    return;
  }

  for (const decl of DEFAULT_SOURCES) {
    results.push(
      await describeDefaultSource(
        mgr,
        decl,
        sources.find((s) => s.id === decl.id),
      ),
    );
  }

  // 非默认源只报个数：它们的健康状况归 aforge source list / update，doctor 不越界。
  // 但"有几个自定义源在生效"是排查渲染差异时的第一个问题，值得一行。
  const custom = sources.filter((s) => findDefaultSource(s.id) === undefined);
  results.push({
    section: 'config',
    level: 'ok',
    item: 'sources/custom',
    detail:
      custom.length === 0
        ? '无自定义源登记'
        : `${custom.length} 个自定义源（启用 ${custom.filter((s) => s.enabled).length} 个）: ${custom.map((s) => s.id).join(', ')}`,
  });
}

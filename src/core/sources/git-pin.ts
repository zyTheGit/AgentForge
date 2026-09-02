/**
 * git 源的远端传输层：命令执行、离线守卫与 pin 序列（Spec §7.6 / §7.8）。
 *
 * 从 `./manager` 分出来的理由：manager 的其余部分是**登记表事务编排**——读
 * sources.json、校验 id 冲突、拼登记项、回写。本文件是**与远端打交道的那一层**，
 * 关注的是「怎么调 git、失败怎么映射成退出码、pin 到 ref 的动作序列是什么」。
 * 两者变化速率不同：新增一种源类型会改前者，git 协议 / pin 语义调整会改后者。
 *
 * 三个符号的分工：
 * - `assertNotOffline`：§7.8 的离线闸门，所有触网操作的第一道；
 * - `gitMust`：单条 git 命令 + 失败 → GenericError(1) 的错误映射（clone 与其余
 *   子命令的 hint 文案不同）；
 * - `clonePinned`：完整 pin 序列，addGitSource 与 materializeGitSource 共用。
 *
 * 全部为 sources 模块内部符号，**不进 `./manager` 的 re-export**：对外导出面
 * （commands / 其它 core 模块 / 测试所见）与拆分前完全一致。
 *
 * git 调用一律经 infra/shell.gitExec（测试可 mock host.exec）。
 */
import path from 'node:path';
import { mkdirp } from '../../infra/fsutil';
import { gitExec } from '../../infra/shell';
import type { EnvSnapshot } from '../env';
import { GenericError, OfflineError } from '../errors';
import { assertWithinStore, type SourceManagerContext } from './store';

/** 执行一条 git 命令；失败 → GenericError(1)（网络 / ref 不存在等通用域）。 */
export async function gitMust(
  ctx: SourceManagerContext,
  args: readonly string[],
  opts: { cwd?: string; what: string },
): Promise<string> {
  const result = await gitExec(ctx.host, args, { cwd: opts.cwd });
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    throw new GenericError(
      `git ${opts.what} 失败（exit ${result.code}）${stderr ? `: ${stderr}` : ''}`,
      {
        hint:
          opts.what === 'clone'
            ? '检查 url 可达性与本机网络（或先配置凭证），然后重试 aforge source add'
            : `检查 ref 是否存在于远端（git ls-remote 验证），然后重试`,
        details: { args, code: result.code, stderr: result.stderr, stdout: result.stdout },
      },
    );
  }
  return result.stdout;
}

/** 离线守卫（§7.8）：AGF_OFFLINE=1 时网络操作 → OfflineError(5)。 */
export function assertNotOffline(env: EnvSnapshot, operation: string): void {
  if (env.offline) {
    throw new OfflineError(`离线模式（AGF_OFFLINE=1）禁止 ${operation}`, {
      hint: '移除 AGF_OFFLINE 环境变量后重试；离线时可用 source add local / 已缓存内容',
    });
  }
}

/**
 * clone 到 store 并 pin 到 ref，返回落定的 commit（§7.6 pin 流程的单一实现）。
 *
 * 序列：clone --depth 1（默认分支）→ fetch --depth 1 origin \<ref\> →
 * checkout --detach FETCH_HEAD → rev-parse HEAD。
 * （分支 / 标签 / commit sha 统一走 fetch+FETCH_HEAD 路径；sha 依赖远端
 * allowReachableSHA1InWant，GitHub 支持。）
 *
 * addGitSource 与 materializeGitSource 共用：前者是"登记同时拉取"，后者是
 * "登记在先、内容后补"（默认注册的官方源走这条）。两处若各写一遍 git 序列，
 * pin 语义就会有两个事实源。
 *
 * 调用方须已校验 url / ref / id（本函数只做 store 边界的纵深防御断言）。
 *
 * **中途失败必清目录**：clone 成功而后续任一步失败时，`store\<id>` 里留下的是
 * **远端默认分支**的内容且 commit 未落定；凡以「目录存在」判"已就绪"的调用点都会
 * 零网络返回这份未 pin 的内容，且不会自愈。清理是 best-effort（原错误优先）。
 */
export async function clonePinned(
  ctx: SourceManagerContext,
  args: { url: string; ref: string; storeDir: string },
): Promise<string> {
  assertWithinStore(ctx, args.storeDir);
  await mkdirp(ctx.host, path.dirname(args.storeDir));
  // 孤儿缓存（登记已删但目录残留 / 上次 clone 中断）清掉重 clone
  if (await ctx.host.exists(args.storeDir)) {
    await ctx.host.rm(args.storeDir);
  }

  try {
    await gitMust(ctx, ['clone', '--depth', '1', '--', args.url, args.storeDir], { what: 'clone' });
    await gitMust(ctx, ['fetch', '--depth', '1', 'origin', args.ref], {
      cwd: args.storeDir,
      what: 'fetch',
    });
    await gitMust(ctx, ['checkout', '--detach', 'FETCH_HEAD'], {
      cwd: args.storeDir,
      what: 'checkout',
    });
    return (
      await gitMust(ctx, ['rev-parse', 'HEAD'], { cwd: args.storeDir, what: 'rev-parse' })
    ).trim();
  } catch (err) {
    try {
      await ctx.host.rm(args.storeDir);
    } catch {
      // best-effort：清理失败最多留下与修复前等同的残骸，原错误优先
    }
    throw err;
  }
}

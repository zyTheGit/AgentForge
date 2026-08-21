/**
 * 文件系统工具：原子写入 / 换行规范化 / BOM / sha256 / mkdirp（Spec §2.5）。
 *
 * 实现策略：统一经注入的 Host 执行副作用（任务要求"经 Host 注入"），
 * 仅 node:crypto（sha256 / 随机后缀）为纯计算直接使用。
 */
import { createHash, randomBytes } from 'node:crypto';
import { PermissionError } from '../core/errors';
import type { LineEnding } from '../core/env';
import type { Host } from './host';

/** 剥离 UTF-8 BOM（U+FEFF）。无 BOM 时原样返回。 */
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** 统一换行：先全部归 LF（含孤立 \r），再按需展开为 CRLF。 */
export function normalizeLineEnding(content: string, eol: LineEnding): string {
  const lf = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * 内容指纹：LF 规范化后的 sha256 hex（小写）。
 * 作为 sync-meta.json 的 contentHash 基准（Spec §3.3），
 * 与 markers.markerSectionHash 共用同一规范，保证换行风格不影响比较。
 */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(normalizeLineEnding(content, 'lf'), 'utf8').digest('hex');
}

/**
 * 错误是否携带权限类 errno（EPERM/EACCES/EROFS）。
 * 导出供读路径（writer 读现有投影文件）与写路径共用同一判定。
 */
export function isPermissionErrno(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}

/** mkdir -p；权限类失败 → PermissionError(4)（Spec §7.3 目录自动创建）。 */
export async function mkdirp(host: Host, dir: string): Promise<void> {
  try {
    await host.mkdirp(dir);
  } catch (err) {
    if (isPermissionErrno(err)) {
      throw new PermissionError(`无法创建目录: ${dir}`, {
        hint: '检查父目录的写权限（必要时以管理员身份运行），或把项目移到用户可写位置',
        details: err,
      });
    }
    throw err;
  }
}

/**
 * 原子写入（Spec §2.5）：同目录临时文件（随机后缀）→ rename 覆盖目标。
 *
 * Windows 细节：
 * - 目标已存在时，rename 前尽力 chmod 0o666 清除只读属性（git clone 常见）；
 * - rename 遇 EPERM/EACCES（只读未除净 / 文件被占用 / 目录 ACL）→ PermissionError(4)。
 *
 * 无论成败，finally 中清理残留临时文件。
 */
export async function atomicWrite(host: Host, target: string, content: string): Promise<void> {
  const tmp = `${target}.agf-${randomBytes(6).toString('hex')}.tmp`;
  try {
    try {
      await host.writeFile(tmp, content);
    } catch (err) {
      // 临时文件创建失败（目标目录无写权限 / 只读卷）同样属于权限域（Spec §6.1 退出码 4）
      if (isPermissionErrno(err)) {
        throw new PermissionError(`无法写入目标文件: ${target}`, {
          hint: '检查目标所在目录的写权限（必要时以管理员身份运行），或把项目移到用户可写位置',
          details: err,
        });
      }
      throw err;
    }

    // Windows 只读属性：写入（rename 覆盖）前尽力去除；失败留给 rename 判定
    if (await host.exists(target)) {
      try {
        await host.chmod(target, 0o666);
      } catch {
        // best-effort：真正的失败由下方 rename 报告
      }
    }

    try {
      await host.rename(tmp, target);
    } catch (err) {
      if (isPermissionErrno(err)) {
        throw new PermissionError(`无法写入目标文件: ${target}`, {
          hint: '检查文件是否被占用（关闭编辑器 / 等待杀毒扫描结束）、是否只读属性、以及所在目录的写权限',
          details: err,
        });
      }
      throw err;
    }
  } finally {
    try {
      if (await host.exists(tmp)) {
        await host.rm(tmp);
      }
    } catch {
      // 临时文件清理失败不影响主流程（下次写入会生成新随机名）
    }
  }
}

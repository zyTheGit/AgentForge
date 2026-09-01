/**
 * 单测共享工具：内存版 fake Host（无任何真实 IO）与脚本化 fake Prompt。
 *
 * - files：内存文件表（path → content），测试可直接读写断言；
 * - dirs：经 mkdirExclusive 原子创建的目录集合（互斥锁语义所需，见下）；
 * - clearReadonlyCalls：记录 clearReadonly 调用的路径（断言"只读属性去除"路径用）；
 * - copyModeCalls：记录 copyMode 的 `from>to`（断言"原权限位被带到临时文件上"）；
 * - spawnInteractiveCalls：记录 spawnInteractive 的 `{ cmd, args }`（断言
 *   `learnings edit` 拉起的编辑器与参数；默认返回退出码 0）；
 * - createScriptedPrompt：按序返回预设应答的 PromptApi（驱动 init -i 五步流程）。
 */
import path from 'node:path';
import type { Host } from '../../src/infra/host';
import type { PromptApi, PromptOption } from '../../src/infra/prompt';

/**
 * 夹具路径的绝对根：win32 `C:\`，posix `/`。
 *
 * 内存 fake host 以路径字符串为键，而被测代码（config/load、sources/*、
 * learning/* 等）用**宿主** `path.join` 拼键。夹具因此必须与宿主同语义：
 * 硬编码 `C:\x` 在 Linux 上既不是绝对路径（`path.resolve` 会拼到 cwd 后面），
 * 分隔符也与 `path.join` 的产物不一致，两处都会让键查不到。
 *
 * 需要断言"另一平台"路径语义的用例（paths / shell / 四个 projector）不用这里，
 * 它们显式注入 OsContext 并配 path.win32 / path.posix，与宿主无关。
 */
export const ABS_ROOT = process.platform === 'win32' ? 'C:\\' : '/';

/** 构造宿主平台语义的绝对路径夹具（分隔符与被测代码的 path.join 一致）。 */
export function abs(...segments: string[]): string {
  return path.join(ABS_ROOT, ...segments);
}

/** spawnInteractive 的调用记录（断言拉起的可执行文件与参数）。 */
export interface SpawnInteractiveCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

export interface FakeHost extends Host {
  readonly files: Map<string, string>;
  /** 已存在的「目录」集合（内存 fs 无目录概念，仅 mkdirExclusive 的互斥判据需要）。 */
  readonly dirs: Set<string>;
  readonly clearReadonlyCalls: string[];
  readonly copyModeCalls: string[];
  readonly spawnInteractiveCalls: SpawnInteractiveCall[];
}

export function createFakeHost(envMap: Readonly<Record<string, string>> = {}): FakeHost {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const clearReadonlyCalls: string[] = [];
  const copyModeCalls: string[] = [];
  const spawnInteractiveCalls: SpawnInteractiveCall[] = [];

  /** 目录是否"存在"：显式创建过，或其下有任意文件键（对齐真实 fs 的目录语义）。 */
  const dirExists = (p: string): boolean => {
    if (dirs.has(p)) {
      return true;
    }
    const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
    return [...files.keys()].some((k) => k.startsWith(prefix));
  };

  const host: FakeHost = {
    files,
    dirs,
    clearReadonlyCalls,
    copyModeCalls,
    spawnInteractiveCalls,
    async readFile(p) {
      const content = files.get(p);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${p}`);
      }
      return content;
    },
    async writeFile(p, content) {
      files.set(p, content);
    },
    async clearReadonly(p) {
      clearReadonlyCalls.push(p);
    },
    async copyMode(from, to) {
      copyModeCalls.push(`${from}>${to}`);
    },
    async exists(p) {
      return files.has(p);
    },
    async listDir(p) {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
    },
    async mkdirp(_p) {
      // 内存 fs 无目录概念，no-op
    },
    async mkdirExclusive(p) {
      // 原子创建语义：已存在 → false（互斥败者）；否则登记为已存在并返回 true
      if (dirExists(p) || files.has(p)) {
        return false;
      }
      dirs.add(p);
      return true;
    },
    async rm(p) {
      // 对齐真实 host 的 recursive+force：删除同名文件 / 目录及其下全部键
      files.delete(p);
      dirs.delete(p);
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) {
          files.delete(key);
        }
      }
      for (const dir of [...dirs]) {
        if (dir.startsWith(prefix)) {
          dirs.delete(dir);
        }
      }
    },
    async stat(p) {
      const content = files.get(p);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${p}`);
      }
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: content.length,
        mtimeMs: 0,
      };
    },
    async lstat(p) {
      const content = files.get(p);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${p}`);
      }
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: content.length,
        mtimeMs: 0,
      };
    },
    async readlink(p) {
      throw errnoError('EINVAL', `not a symlink: ${p}`);
    },
    async rename(from, to) {
      const content = files.get(from);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${from}`);
      }
      files.delete(from);
      files.set(to, content);
    },
    async exec() {
      return { stdout: '', stderr: '', code: 0 };
    },
    async spawnInteractive(cmd, args, opts) {
      // 只记账不起进程：默认退出码 0（编辑器正常退出）；需要非零码的用例自行覆盖
      spawnInteractiveCalls.push({ cmd, args: [...args], cwd: opts?.cwd });
      return 0;
    },
    now() {
      return new Date(0);
    },
    env(key) {
      return envMap[key];
    },
    homedir() {
      // 默认取不到：家目录兜底属于"环境变量都缺失"的分支，用例需要时自行覆盖
      return undefined;
    },
    hostname() {
      // 同上：机器/用户标识默认为"未知"，需要断言兜底行为的用例自行覆盖
      return undefined;
    },
    username() {
      return undefined;
    },
  };

  return host;
}

/** 构造带 errno 的错误对象（模拟 node:fs 抛出的 EPERM/EACCES 等）。 */
export function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// 脚本化 fake Prompt（init -i 交互流程测试）
// ---------------------------------------------------------------------------

/** 单条预设应答（kind 必须与实际提问匹配，脚本与流程错位时立即报错）。 */
export interface ScriptedAnswer {
  readonly kind: 'select' | 'confirm' | 'multiselect';
  readonly value: unknown;
  /** 应答前的副作用（模拟"用户在 confirm 等待期间编辑了文件"等场景）。 */
  readonly effect?: () => void | Promise<void>;
}

/** 提问调用记录（断言交互步骤序列 / 确认次数）。 */
export interface PromptCall {
  readonly kind: 'select' | 'confirm' | 'multiselect' | 'note';
  readonly message: string;
}

export interface ScriptedPrompt {
  readonly prompt: PromptApi;
  readonly calls: readonly PromptCall[];
  /** 提问（select/confirm/multiselect）总次数（确认次数上限断言用）。 */
  readonly questionCount: () => number;
}

/**
 * 脚本化 PromptApi：按序返回预设应答。
 * - multiselect 模拟真实实现的"按 options 声明顺序稳定输出"；
 * - 应答耗尽后再被提问 → 抛错（脚本与流程错位的哨兵）；
 * - note 不消费应答，仅记录调用。
 */
export function createScriptedPrompt(answers: readonly ScriptedAnswer[]): ScriptedPrompt {
  const queue = [...answers];
  const calls: PromptCall[] = [];

  function nextAnswer(kind: 'select' | 'confirm' | 'multiselect'): unknown {
    const answer = queue.shift();
    if (answer === undefined || answer.kind !== kind) {
      throw new Error(
        `scripted prompt 错位：期望 ${kind}，实际应答为 ${answer === undefined ? '(耗尽)' : answer.kind}`,
      );
    }
    return answer;
  }

  const prompt: PromptApi = {
    async select<T extends string>(
      _message: string,
      _options: readonly PromptOption<T>[],
      _initialValue?: T,
    ): Promise<T> {
      calls.push({ kind: 'select', message: _message });
      const answer = nextAnswer('select') as {
        value: unknown;
        effect?: () => void | Promise<void>;
      };
      await answer.effect?.();
      return answer.value as T;
    },
    async confirm(_message: string, _initialValue?: boolean): Promise<boolean> {
      calls.push({ kind: 'confirm', message: _message });
      const answer = nextAnswer('confirm') as {
        value: unknown;
        effect?: () => void | Promise<void>;
      };
      await answer.effect?.();
      return answer.value as boolean;
    },
    async multiselect<T extends string>(
      _message: string,
      options: readonly PromptOption<T>[],
      _initialValues?: readonly T[],
      _required?: boolean,
    ): Promise<T[]> {
      calls.push({ kind: 'multiselect', message: _message });
      const answer = nextAnswer('multiselect') as {
        value: unknown;
        effect?: () => void | Promise<void>;
      };
      await answer.effect?.();
      const picked = new Set(answer.value as readonly string[]);
      // 与真实实现一致：按声明顺序稳定输出 value 数组（非选项对象）
      return options.filter((option) => picked.has(option.value)).map((option) => option.value);
    },
    note(_message: string, _title?: string): void {
      calls.push({ kind: 'note', message: _title ?? _message });
    },
  };

  return {
    prompt,
    calls,
    questionCount: () => calls.filter((call) => call.kind !== 'note').length,
  };
}

/**
 * 单测共享工具：内存版 fake Host（无任何真实 IO）与脚本化 fake Prompt。
 *
 * - files：内存文件表（path → content），测试可直接读写断言；
 * - chmodCalls：记录 chmod 调用的路径（断言"只读属性去除"路径用）；
 * - createScriptedPrompt：按序返回预设应答的 PromptApi（驱动 init -i 五步流程）。
 */
import type { Host } from '../../src/infra/host';
import type { PromptApi, PromptOption } from '../../src/infra/prompt';

export interface FakeHost extends Host {
  readonly files: Map<string, string>;
  readonly chmodCalls: string[];
}

export function createFakeHost(envMap: Readonly<Record<string, string>> = {}): FakeHost {
  const files = new Map<string, string>();
  const chmodCalls: string[] = [];

  const host: FakeHost = {
    files,
    chmodCalls,
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
    async chmod(p, _mode) {
      chmodCalls.push(p);
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
    async rm(p) {
      files.delete(p);
    },
    async stat(p) {
      const content = files.get(p);
      if (content === undefined) {
        throw errnoError('ENOENT', `no such file: ${p}`);
      }
      return { isFile: true, isDirectory: false, size: content.length, mtimeMs: 0 };
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
    now() {
      return new Date(0);
    },
    env(key) {
      return envMap[key];
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
      const answer = nextAnswer('select') as { value: unknown; effect?: () => void | Promise<void> };
      await answer.effect?.();
      return answer.value as T;
    },
    async confirm(_message: string, _initialValue?: boolean): Promise<boolean> {
      calls.push({ kind: 'confirm', message: _message });
      const answer = nextAnswer('confirm') as { value: unknown; effect?: () => void | Promise<void> };
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
      const answer = nextAnswer('multiselect') as { value: unknown; effect?: () => void | Promise<void> };
      await answer.effect?.();
      const picked = new Set(answer.value as readonly string[]);
      // 与真实实现一致：按声明顺序稳定输出 value 数组（非选项对象）
      return options
        .filter((option) => picked.has(option.value))
        .map((option) => option.value);
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

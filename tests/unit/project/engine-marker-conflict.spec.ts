/**
 * marker 区间冲突预检查单测（Spec §8.2-4，fake host）：
 * 首次 sync 不检查 / 区间内改动 → ConflictError(3) 且零副作用 / 区间外改动不误报 /
 * --force 跳过 / dry-run 同样检查 / contentHash 基准与投影区间读回值一致 /
 * 损坏 sync-meta → ConfigError(2) / 无记录的 target 不检查。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConflictError, ConfigError } from '../../../src/core/errors';
import { readEnv } from '../../../src/core/env';
import { currentOs } from '../../../src/core/paths';
import { syncOnce } from '../../../src/core/project/engine';
import { syncMetaPath } from '../../../src/core/project/sync-meta';
import {
  DEFAULT_MARKER_BEGIN,
  DEFAULT_MARKER_END,
  splitByMarkers,
  wrapWithMarkers,
} from '../../../src/core/markers';
import { sha256Hex } from '../../../src/infra/fsutil';
import { createFakeHost, type FakeHost } from '../test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const PROJECT_SOT = path.join(CWD, '.agentforge');
const CLAUDE_MD = path.join(CWD, 'CLAUDE.md');

const PROFILE_YAML = 'version: 1\nscope: project\ntargets: [claude]\n';
const HABITS_YAML = 'version: 1\n';
const RENDERED_MINIMAL = '# AgentForge Rules\n';

/** 目录感知 listDir 的 fake host（Windows 反斜杠 key 兼容，同 engine.spec）。 */
function createConflictHost(): FakeHost {
  const base = createFakeHost({ USERPROFILE: HOME });
  const host: FakeHost = {
    ...base,
    async listDir(p) {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      const names = new Set<string>();
      for (const key of base.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest === '') continue;
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
  return host;
}

async function seedProjectSoT(
  host: FakeHost,
  profile = PROFILE_YAML,
): Promise<void> {
  await host.writeFile(path.join(PROJECT_SOT, 'profile.yaml'), profile);
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
}

function syncOptions(host: FakeHost, overrides: Record<string, unknown> = {}) {
  return {
    host,
    env: readEnv(host),
    os: OS,
    cwd: CWD,
    agentforgeVersion: 'test-0.1.0',
    dryRun: false,
    ...overrides,
  };
}

/** 布置"已成功 sync 一次"的基准（CLAUDE.md + sync-meta 已落盘）。 */
async function seedSynced(host: FakeHost): Promise<void> {
  await seedProjectSoT(host);
  await syncOnce(syncOptions(host));
}

/** 读当前投影区间 hash（marker 区间 LF 规范化形态）。 */
function currentSectionHash(host: FakeHost): string {
  const content = host.files.get(CLAUDE_MD) as string;
  return sha256Hex(splitByMarkers(content, DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END).inside);
}

describe('marker 冲突预检查（§8.2-4）', () => {
  it('首次 sync（sync-meta 不存在）→ 不检查：既有 CLAUDE.md 带任意区间内容也直接覆盖', async () => {
    const host = createConflictHost();
    await seedProjectSoT(host);
    await host.writeFile(
      CLAUDE_MD,
      wrapWithMarkers('# Legacy junk content\n', DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END),
    );
    const result = await syncOnce(syncOptions(host));
    // claude 有两项（CLAUDE.md + .mcp.json）：全部落盘
    expect(result.targets[0]?.statuses.every((s) => s === 'written')).toBe(true);
    expect(currentSectionHash(host)).toBe(result.contentHash);
  });

  it('区间内容被手动修改 → ConflictError(3)，message 引导 doctor，hint 含 --force', async () => {
    const host = createConflictHost();
    await seedSynced(host);
    const content = host.files.get(CLAUDE_MD) as string;
    host.files.set(CLAUDE_MD, content.replace('# AgentForge Rules', '# Tampered Rules'));

    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    const conflict = err as ConflictError;
    expect(conflict.code).toBe(3);
    expect(conflict.message).toContain('aforge doctor');
    expect(conflict.hint).toContain('--force');
    const conflicts = (conflict.details as { conflicts?: unknown }).conflicts as string[];
    expect(conflicts).toContain(CLAUDE_MD);
  });

  it('冲突时投影文件保持原样（预检查在备份/写入之前，零副作用）', async () => {
    const host = createConflictHost();
    await seedSynced(host);
    const content = host.files.get(CLAUDE_MD) as string;
    const tampered = content.replace('# AgentForge Rules', '# Tampered Rules');
    host.files.set(CLAUDE_MD, tampered);

    await syncOnce(syncOptions(host)).catch(() => undefined);
    expect(host.files.get(CLAUDE_MD)).toBe(tampered); // 未被修改、未被回滚重写
  });

  it('marker 区间外的手动内容 → 不算冲突，sync 成功且外部内容保留', async () => {
    const host = createConflictHost();
    await seedSynced(host);
    const content = host.files.get(CLAUDE_MD) as string;
    host.files.set(CLAUDE_MD, `# Manual project notes\n\n${content}`);

    const result = await syncOnce(syncOptions(host));
    expect(result.targets[0]?.statuses.every((s) => s === 'unchanged')).toBe(true);
    expect(host.files.get(CLAUDE_MD)).toContain('# Manual project notes');
  });

  it('冲突后 --force 跳过预检查，成功覆盖为最新渲染', async () => {
    const host = createConflictHost();
    await seedSynced(host);
    const content = host.files.get(CLAUDE_MD) as string;
    host.files.set(CLAUDE_MD, content.replace('# AgentForge Rules', '# Tampered Rules'));

    const result = await syncOnce(syncOptions(host, { force: true }));
    expect(result.targets[0]?.statuses).toContain('written');
    const split = splitByMarkers(
      host.files.get(CLAUDE_MD) as string,
      DEFAULT_MARKER_BEGIN,
      DEFAULT_MARKER_END,
    );
    expect(split.inside).toBe(`\n${RENDERED_MINIMAL}`);
    expect(currentSectionHash(host)).toBe(result.contentHash);
  });

  it('dry-run 同样执行冲突检查（只读诊断，§8.2-4 不因 dry-run 放宽）', async () => {
    const host = createConflictHost();
    await seedSynced(host);
    const content = host.files.get(CLAUDE_MD) as string;
    host.files.set(CLAUDE_MD, content.replace('# AgentForge Rules', '# Tampered Rules'));

    const err = await syncOnce(syncOptions(host, { dryRun: true })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('无冲突的重复 sync → 幂等成功（unchanged）', async () => {
    const host = createConflictHost();
    await seedSynced(host);
    const result = await syncOnce(syncOptions(host));
    expect(result.targets[0]?.statuses.every((s) => s === 'unchanged')).toBe(true);
  });

  it('contentHash 基准统一：sync-meta 记录值 === 投影区间实际读回 hash（M7 核心契约）', async () => {
    const host = createConflictHost();
    await seedSynced(host);
    const meta = JSON.parse(
      host.files.get(syncMetaPath(PROJECT_SOT)) as string,
    ) as { targets: Record<string, { contentHash: string }> };
    expect(meta.targets.claude?.contentHash).toBe(currentSectionHash(host));
  });

  it('损坏的 sync-meta → ConfigError(2)（不静默丢基准，sync-meta.ts 契约）', async () => {
    const host = createConflictHost();
    await seedSynced(host);
    host.files.set(syncMetaPath(PROJECT_SOT), '{ broken json');
    const err = await syncOnce(syncOptions(host)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe(2);
  });

  it('sync-meta 中无记录的 target → 不检查（部分 target 后启用的场景）', async () => {
    const host = createConflictHost();
    // 第一次只 sync claude（sync-meta 只记录 claude）
    await seedProjectSoT(host, 'version: 1\nscope: project\ntargets: [claude, pi]\n');
    await syncOnce(syncOptions(host, { targetsFilter: ['claude'] }));
    // pi 的投影文件即使已被写坏 marker 区间也不检查（无基准），首次投影直接落盘
    const piAgents = path.join(CWD, 'AGENTS.md');
    await host.writeFile(
      piAgents,
      wrapWithMarkers('# Tampered pi rules\n', DEFAULT_MARKER_BEGIN, DEFAULT_MARKER_END),
    );
    const result = await syncOnce(syncOptions(host));
    const pi = result.targets.find((t) => t.targetId === 'pi');
    expect(pi?.statuses).toContain('written');
    expect(host.files.get(piAgents)).toContain(RENDERED_MINIMAL);
  });
});

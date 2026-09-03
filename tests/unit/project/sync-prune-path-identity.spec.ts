/**
 * §7.6 prune 的路径身份口径回归（issue #67 / #68）。
 *
 * 两个失效模式都出在「记账路径与本轮产物路径的比对」上，且都是静默的：
 * 1. **#67（P0 数据丢失）**：上一轮记账的拼写与本轮不同（Windows 盘符大小写随启动
 *    方式漂移、WSL 的 `/mnt/c` 是大小写不敏感的 drvfs），裸字符串比较把「本轮刚写出来
 *    的产物」判成「上轮遗留」；内容 hash 又恰好相等（同一个文件），于是删除条件全部
 *    满足——磁盘上只剩 SoT，而新写的 sync-meta 声称这些产物都在；
 * 2. **#68**：记账路径是另一平台写下的形态（`C:\...` vs `/mnt/c/...`），`exists()` 为假，
 *    旧实现静默 `continue` 且把记录从记账里抹掉，那些产物从此无人认领。
 *
 * 用「大小写不敏感的 fake host」复现 1，而不是依赖跑测试的宿主平台恰好不敏感：
 * 记账拼写与磁盘键的关系是这两个 bug 的全部，把它做成显式的测试装置才能在 POSIX CI
 * 上也跑出同一条路径。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctorChecks } from '../../../src/core/doctor/checks';
import { readEnv } from '../../../src/core/env';
import { currentOs, nativePathFlavor } from '../../../src/core/paths';
import { syncOnce } from '../../../src/core/project/engine';
import { syncMetaPath } from '../../../src/core/project/sync-meta';
import { createFakeHost, type FakeHost } from '../test-utils';

const OS = currentOs();
const HOME = path.resolve('/home/u');
const CWD = path.resolve('/proj');
const PROJECT_SOT = path.join(CWD, '.agentforge');
const ARTIFACTS_ITEM = 'sync-meta/artifacts';

const SKILL_DOC = ['---', 'name: lazy', 'description: 备货技能', '---', '', '# Lazy', ''].join(
  '\n',
);

interface RecordedArtifact {
  path: string;
  contentHash: string;
  targetId: string;
}

/**
 * 目录感知 + **大小写不敏感**的 fake host（模拟 NTFS / drvfs）。
 *
 * 读写删都先把入参折叠到已有键上：这正是 #67 的前提——记账里的另一种拼写在这种
 * 文件系统上确实指向同一个文件，所以 `exists` 为真、hash 相等，删除条件全部成立。
 */
function createCaseInsensitiveHost(): FakeHost {
  const base = createFakeHost({ USERPROFILE: HOME });
  const resolveKey = (p: string): string => {
    if (base.files.has(p)) {
      return p;
    }
    const folded = p.toLowerCase();
    for (const key of base.files.keys()) {
      if (key.toLowerCase() === folded) {
        return key;
      }
    }
    return p;
  };
  return {
    ...base,
    async readFile(p) {
      return base.readFile(resolveKey(p));
    },
    async exists(p) {
      return base.exists(resolveKey(p));
    },
    async rm(p) {
      return base.rm(resolveKey(p));
    },
    async listDir(p) {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
      const names = new Set<string>();
      for (const key of base.files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (rest === '') {
            continue;
          }
          const sep = rest.search(/[\\/]/);
          names.add(sep === -1 ? rest : rest.slice(0, sep));
        }
      }
      return [...names].sort();
    },
  };
}

/** 四家全开 + 一个已安装的常驻 skill（保证记账里有整文件产物）。 */
async function seed(host: FakeHost): Promise<void> {
  await host.writeFile(
    path.join(PROJECT_SOT, 'profile.yaml'),
    [
      'version: 1',
      'scope: project',
      'targets: [claude, codex, opencode, pi]',
      'skills:',
      '  always: [lazy]',
      '',
    ].join('\n'),
  );
  await host.writeFile(path.join(PROJECT_SOT, 'habits.yaml'), 'version: 1\n');
  await host.writeFile(path.join(PROJECT_SOT, 'skills', 'lazy', 'SKILL.md'), SKILL_DOC);
}

function syncOptions(host: FakeHost) {
  return {
    host,
    env: readEnv(host),
    os: OS,
    cwd: CWD,
    agentforgeVersion: 'test-0.1.0',
    dryRun: false,
  };
}

async function readRecorded(host: FakeHost): Promise<RecordedArtifact[]> {
  const meta = JSON.parse(await host.readFile(syncMetaPath(PROJECT_SOT))) as {
    artifacts?: RecordedArtifact[];
  };
  return meta.artifacts ?? [];
}

/** 改写落盘 sync-meta 的 artifacts（模拟"上一轮由另一个进程记下的账"）。 */
async function rewriteRecorded(host: FakeHost, artifacts: RecordedArtifact[]): Promise<void> {
  const file = syncMetaPath(PROJECT_SOT);
  const meta = JSON.parse(await host.readFile(file)) as Record<string, unknown>;
  meta.artifacts = artifacts;
  await host.writeFile(file, `${JSON.stringify(meta, null, 2)}\n`);
}

describe('prune 路径身份（issue #67：拼写漂移不得删掉活产物）', () => {
  it('记账拼写与本轮仅大小写不同 → 一个都不删，报进 pruneSkipped', async () => {
    const host = createCaseInsensitiveHost();
    await seed(host);
    await syncOnce(syncOptions(host));

    const recorded = await readRecorded(host);
    expect(recorded.length).toBeGreaterThan(0);
    // 上一轮进程用另一种拼写记账（同一批文件在大小写不敏感的卷上）
    await rewriteRecorded(
      host,
      recorded.map((a) => ({ ...a, path: a.path.toUpperCase() })),
    );

    const result = await syncOnce(syncOptions(host));

    for (const artifact of recorded) {
      expect(host.files.has(artifact.path)).toBe(true);
    }
    expect(result.pruned.filter((p) => p.kind === 'artifact')).toEqual([]);
    expect(result.pruneSkipped.length).toBe(recorded.length);
    for (const skip of result.pruneSkipped) {
      expect(skip.reason).toContain('大小写');
    }
    // 记账以本轮拼写重写 → 一次自愈，下一轮不再报
    const after = await readRecorded(host);
    expect(after.map((a) => a.path).sort()).toEqual(recorded.map((a) => a.path).sort());
  });

  it('同一拼写的对照组：产物照常保留且无 skip', async () => {
    const host = createCaseInsensitiveHost();
    await seed(host);
    await syncOnce(syncOptions(host));
    const recorded = await readRecorded(host);

    const result = await syncOnce(syncOptions(host));

    for (const artifact of recorded) {
      expect(host.files.has(artifact.path)).toBe(true);
    }
    expect(result.pruned).toEqual([]);
    expect(result.pruneSkipped).toEqual([]);
  });
});

describe('prune 跨平台记账（issue #68：不静默丢弃另一平台的账）', () => {
  it('另一平台形态的记账 → 报 skip 且记录保留在 sync-meta 里', async () => {
    const host = createCaseInsensitiveHost();
    await seed(host);
    await syncOnce(syncOptions(host));
    const recorded = await readRecorded(host);
    const sample = recorded[0];
    expect(sample).toBeDefined();
    if (sample === undefined) {
      return;
    }

    // 另一侧（Windows ↔ WSL）写下的绝对路径：本进程既 stat 不到也不该删
    const alien =
      nativePathFlavor(OS) === 'win32'
        ? '/proj/.claude/skills/lazy/SKILL.md'
        : 'C:\\proj\\.claude\\skills\\lazy\\SKILL.md';
    await rewriteRecorded(host, [
      ...recorded,
      { path: alien, contentHash: sample.contentHash, targetId: 'claude' },
    ]);

    const result = await syncOnce(syncOptions(host));

    const skip = result.pruneSkipped.find((s) => s.path === alien);
    expect(skip).toBeDefined();
    expect(skip?.reason).toContain('无法寻址');
    expect(result.pruned.filter((p) => p.kind === 'artifact')).toEqual([]);
    const after = await readRecorded(host);
    expect(after.map((a) => a.path)).toContain(alien);
  });
});

describe('doctor：记账的整文件产物是否还在磁盘上（§7.6）', () => {
  function doctorOpts(host: FakeHost) {
    return { host, env: readEnv(host), os: OS, cwd: CWD };
  }

  it('全都在 → ok', async () => {
    const host = createCaseInsensitiveHost();
    await seed(host);
    await syncOnce(syncOptions(host));

    const report = await runDoctorChecks(doctorOpts(host));
    const result = report.results.find((r) => r.item === ARTIFACTS_ITEM);
    expect(result?.level).toBe('ok');
    expect(result?.detail).toContain('均存在');
  });

  it('产物被删 → warn 且列出缺失路径，退出码不受影响', async () => {
    const host = createCaseInsensitiveHost();
    await seed(host);
    await syncOnce(syncOptions(host));
    const recorded = await readRecorded(host);
    const victim = recorded[0];
    expect(victim).toBeDefined();
    if (victim === undefined) {
      return;
    }
    await host.rm(victim.path);

    const report = await runDoctorChecks(doctorOpts(host));
    const result = report.results.find((r) => r.item === ARTIFACTS_ITEM);
    expect(result?.level).toBe('warn');
    expect(result?.detail).toContain(victim.path);
    expect(report.exitCode).toBe(0);
  });
});

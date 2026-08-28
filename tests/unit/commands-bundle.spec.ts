/**
 * `aforge bundle export` / `bundle import` 单测。
 *
 * 覆盖两条命令的契约与不变量：
 * - export：带走 habits/profile/sources + 五个目录；剔除 sync-meta.json（machine-state）、
 *   .agf-backup（transient）、store（cache）、非布局条目（not-part-of-sot），且都进
 *   manifest.excluded；habits.detected 被剔、profile 的 MCP 凭据被抹并登记进 redacted；
 * - export 退出码：--out 非空 → 3；--out 落在 SoT 内 → 2；该层未 init → 2；
 * - import：哈希校验通过后落盘；**校验失败一个字节都不写**（2）；manifest 路径越界 → 2；
 *   三种冲突策略（skip 默认 / overwrite / rename）；manifest 未登记的多余文件不导入；
 * - 往返：export → import 到另一个项目根，内容逐字节一致。
 *
 * host 用 sources/helpers 的目录感知 fake host（本命令要判目录存在性、递归列目录、
 * lstat 判类型）；路径夹具一律走 test-utils.abs（宿主平台语义）。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBundleExport, runBundleImport } from '../../src/commands/bundle';
import { BUNDLE_CONTENT_DIR, BUNDLE_MANIFEST_FILE } from '../../src/core/bundle/layout';
import { REDACTED_PLACEHOLDER } from '../../src/core/bundle/redact';
import { currentOs } from '../../src/core/paths';
import { sha256Hex } from '../../src/infra/fsutil';
import { createDirAwareHost, type DirAwareHost } from './sources/helpers';
import { abs } from './test-utils';

const OS = currentOs();
const HOME = abs('home', 'u');
const PROJECT_ROOT = abs('proj');
const PROJECT_SOT = path.join(PROJECT_ROOT, '.agentforge');
const OUT_DIR = abs('out', 'bundle');
const OTHER_ROOT = abs('proj2');
const OTHER_SOT = path.join(OTHER_ROOT, '.agentforge');

/** habits：detected 有内容（导出时应被剔掉），runtime 是用户声明（必须留下）。 */
const HABITS_YAML = [
  'version: 1',
  'runtime:',
  '  node:',
  '    manager: fnm',
  'detected:',
  '  node_version: v22.1.0',
  '',
].join('\n');

/** profile：一个 http server 带 Authorization 头 + 一个 stdio server 带 env。 */
const PROFILE_YAML = [
  'version: 1',
  'targets:',
  '  - claude',
  'mcp:',
  '  servers:',
  '    - name: ctx7',
  '      transport: http',
  '      url: https://mcp.example.com/mcp',
  '      headers:',
  '        Authorization: Bearer super-secret',
  '    - name: jenkins',
  '      transport: stdio',
  '      command: npx',
  '      env:',
  '        JENKINS_TOKEN: t0ken',
  '',
].join('\n');

const SOURCES_JSON = JSON.stringify(
  {
    version: 1,
    sources: [
      { id: 'local-notes', type: 'local', path: abs('clones', 'notes') },
      { id: 'vercel', type: 'git', url: 'https://example.com/x.git', ref: 'main' },
    ],
  },
  null,
  2,
);

function ctxFor(host: DirAwareHost, cwd = PROJECT_ROOT) {
  return { host, cwd, os: OS };
}

/** 一份"用过一段时间"的 project 层 SoT：内容 + 应被剔除的本机状态。 */
function seed(): DirAwareHost {
  const host = createDirAwareHost({ USERPROFILE: HOME });
  host.files.set(path.join(PROJECT_SOT, 'habits.yaml'), HABITS_YAML);
  host.files.set(path.join(PROJECT_SOT, 'profile.yaml'), PROFILE_YAML);
  host.files.set(path.join(PROJECT_SOT, 'sources.json'), SOURCES_JSON);
  host.files.set(path.join(PROJECT_SOT, 'custom', 'code-org.md'), '## Code\n\nkeep files small\n');
  host.files.set(path.join(PROJECT_SOT, 'learnings', 'l-001.yaml'), 'id: l-001\n');
  host.files.set(path.join(PROJECT_SOT, 'skills', 'pdf', 'SKILL.md'), '# pdf\n');
  host.files.set(path.join(PROJECT_SOT, 'skills', 'pdf', 'ref', 'notes.md'), 'nested\n');
  // 以下四项都不该进 bundle
  host.files.set(path.join(PROJECT_SOT, 'sync-meta.json'), '{"version":1}');
  host.files.set(path.join(PROJECT_SOT, '.agf-backup', 'journal.json'), '{}');
  host.files.set(path.join(PROJECT_SOT, 'store', 'vercel', 'README.md'), 'cached clone\n');
  host.files.set(path.join(PROJECT_SOT, 'scratch.txt'), 'random note\n');
  return host;
}

/** bundle 内容文件的绝对路径。 */
function bundleFile(rel: string, outDir = OUT_DIR): string {
  return path.join(outDir, BUNDLE_CONTENT_DIR, ...rel.split('/'));
}

/** 把若干路径伪装成 symlink（fake host 的 lstat 默认恒为 false）。 */
function markSymlinks(host: DirAwareHost, links: readonly string[]): void {
  const real = host.lstat.bind(host);
  const set = new Set(links);
  host.lstat = async (p: string) => {
    const stat = await real(p);
    return set.has(p) ? { ...stat, isSymbolicLink: true } : stat;
  };
}

describe('bundle export', () => {
  it('carries user content and leaves machine state behind', async () => {
    const host = seed();
    const result = await runBundleExport(ctxFor(host), { out: OUT_DIR });

    expect(result.scope).toBe('project');
    expect(result.sotRoot).toBe(PROJECT_SOT);
    expect(result.manifestFile).toBe(path.join(OUT_DIR, BUNDLE_MANIFEST_FILE));
    expect(result.manifest.files.map((f) => f.path)).toEqual([
      'custom/code-org.md',
      'habits.yaml',
      'learnings/l-001.yaml',
      'profile.yaml',
      'skills/pdf/SKILL.md',
      'skills/pdf/ref/notes.md',
      'sources.json',
    ]);
    expect(result.manifest.excluded).toEqual([
      { path: '.agf-backup', reason: 'transient' },
      { path: 'scratch.txt', reason: 'not-part-of-sot' },
      { path: 'store', reason: 'cache' },
      { path: 'sync-meta.json', reason: 'machine-state' },
    ]);
    // 内容真的落盘了（含嵌套目录），且哈希与 manifest 记账一致
    for (const entry of result.manifest.files) {
      const content = host.files.get(bundleFile(entry.path));
      expect(content, entry.path).toBeDefined();
      expect(sha256Hex(content as string)).toBe(entry.sha256);
    }
  });

  it('drops habits.detected and redacts MCP credentials by default', async () => {
    const host = seed();
    const result = await runBundleExport(ctxFor(host), { out: OUT_DIR });

    const habits = host.files.get(bundleFile('habits.yaml')) as string;
    expect(habits).toContain('manager: fnm');
    expect(habits).not.toContain('node_version');

    const profile = host.files.get(bundleFile('profile.yaml')) as string;
    expect(profile).not.toContain('super-secret');
    expect(profile).not.toContain('t0ken');
    expect(profile).toContain(REDACTED_PLACEHOLDER);
    expect(result.manifest.redacted).toEqual([
      'mcp.servers[ctx7].headers.Authorization',
      'mcp.servers[jenkins].env.JENKINS_TOKEN',
    ]);
    expect(result.manifest.files.find((f) => f.path === 'profile.yaml')?.transformed).toBe(true);
    // local 源与被抹凭据都要有 warning（换机器后需要人工跟进）
    expect(result.manifest.warnings.some((w) => w.includes('local-notes'))).toBe(true);
    expect(result.manifest.warnings.some((w) => w.includes('credential'))).toBe(true);
  });

  it('keeps secrets and detected when explicitly asked', async () => {
    const host = seed();
    const result = await runBundleExport(ctxFor(host), {
      out: OUT_DIR,
      redact: false,
      keepDetected: true,
    });

    expect(host.files.get(bundleFile('habits.yaml'))).toContain('node_version');
    expect(host.files.get(bundleFile('profile.yaml'))).toContain('super-secret');
    expect(result.manifest.redacted).toEqual([]);
    // 原文直拷 → 不算 transformed
    expect(result.manifest.files.every((f) => !f.transformed)).toBe(true);
  });

  it('refuses a non-empty --out (exit 3) and an --out inside the SoT (exit 2)', async () => {
    const host = seed();
    host.files.set(path.join(OUT_DIR, 'stale.txt'), 'x');
    await expect(runBundleExport(ctxFor(host), { out: OUT_DIR })).rejects.toMatchObject({
      code: 3,
    });

    const clean = seed();
    await expect(
      runBundleExport(ctxFor(clean), { out: path.join(PROJECT_SOT, 'export') }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('requires the layer to be initialized (exit 2)', async () => {
    const host = createDirAwareHost({ USERPROFILE: HOME });
    await expect(runBundleExport(ctxFor(host), { out: OUT_DIR })).rejects.toMatchObject({
      code: 2,
    });
  });

  it('does not follow a top-level carry dir that is itself a symlink', async () => {
    const host = seed();
    const skillsDir = path.join(PROJECT_SOT, 'skills');
    markSymlinks(host, [skillsDir]);

    const result = await runBundleExport(ctxFor(host), { out: OUT_DIR });

    // collectTree 只判子项，顶层目录自己是 symlink 得由 export 挡掉，否则链接目标整棵被打包
    expect(result.manifest.files.map((f) => f.path)).not.toContain('skills/pdf/SKILL.md');
    expect(result.skipped).toEqual([{ path: skillsDir, reason: 'symlink' }]);
    expect(result.manifest.warnings.some((w) => w.includes('skipped symlink'))).toBe(true);
  });

  it('warns about credential surfaces redact cannot reach', async () => {
    const host = seed();
    const result = await runBundleExport(ctxFor(host), { out: OUT_DIR });

    expect(result.manifest.warnings.some((w) => w.includes('check command / args / url'))).toBe(
      true,
    );
  });
});

describe('bundle import', () => {
  /** 先导出一份 bundle，返回同一个 host（bundle 与两个项目根共存于内存 fs）。 */
  async function exported(): Promise<DirAwareHost> {
    const host = seed();
    await runBundleExport(ctxFor(host), { out: OUT_DIR });
    return host;
  }

  it('round-trips into a fresh SoT byte-for-byte', async () => {
    const host = await exported();
    const result = await runBundleImport(ctxFor(host, OTHER_ROOT), { from: OUT_DIR });

    expect(result.sotRoot).toBe(OTHER_SOT);
    expect(result.entries.every((e) => e.action === 'written')).toBe(true);
    expect(result.unlisted).toEqual([]);
    for (const entry of result.manifest.files) {
      expect(host.files.get(path.join(OTHER_SOT, ...entry.path.split('/')))).toBe(
        host.files.get(bundleFile(entry.path)),
      );
    }
  });

  it('writes nothing when a file was tampered with (exit 2)', async () => {
    const host = await exported();
    host.files.set(bundleFile('custom/code-org.md'), 'tampered\n');

    await expect(
      runBundleImport(ctxFor(host, OTHER_ROOT), { from: OUT_DIR }),
    ).rejects.toMatchObject({ code: 2 });
    // fail-fast 在写入阶段之前：目标层一个文件都没有
    expect([...host.files.keys()].some((k) => k.startsWith(OTHER_SOT))).toBe(false);
  });

  it('rejects a manifest path that escapes the SoT (exit 2)', async () => {
    const host = await exported();
    const manifestFile = path.join(OUT_DIR, BUNDLE_MANIFEST_FILE);
    const manifest = JSON.parse(host.files.get(manifestFile) as string);
    manifest.files = [{ path: '../../evil.md', sha256: sha256Hex('x'), transformed: false }];
    host.files.set(manifestFile, JSON.stringify(manifest));

    await expect(
      runBundleImport(ctxFor(host, OTHER_ROOT), { from: OUT_DIR }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('rejects machine state smuggled in through the manifest (exit 2)', async () => {
    const host = await exported();
    const manifestFile = path.join(OUT_DIR, BUNDLE_MANIFEST_FILE);
    const manifest = JSON.parse(host.files.get(manifestFile) as string);
    // 形态完全合法的相对路径，但 sync-meta.json 是本机状态：导进去会变成下一轮 prune 的删除白名单
    const smuggled = '{"version":1}';
    manifest.files = [{ path: 'sync-meta.json', sha256: sha256Hex(smuggled), transformed: false }];
    host.files.set(manifestFile, JSON.stringify(manifest));
    host.files.set(bundleFile('sync-meta.json'), smuggled);

    await expect(
      runBundleImport(ctxFor(host, OTHER_ROOT), { from: OUT_DIR }),
    ).rejects.toMatchObject({ code: 2 });
    expect(host.files.has(path.join(OTHER_SOT, 'sync-meta.json'))).toBe(false);
  });

  it('refuses to write through a symlink already sitting in the target SoT (exit 2)', async () => {
    const host = await exported();
    markSymlinks(host, [path.join(OTHER_SOT, 'custom')]);
    host.files.set(path.join(OTHER_SOT, 'custom', 'placeholder'), 'x\n');

    await expect(
      runBundleImport(ctxFor(host, OTHER_ROOT), { from: OUT_DIR }),
    ).rejects.toMatchObject({ code: 2 });
    // 与 verifyFiles 同一个契约：抛错时一个字节都没写
    expect(host.files.has(path.join(OTHER_SOT, 'habits.yaml'))).toBe(false);
  });

  it('honours the conflict policy (skip default / overwrite / rename)', async () => {
    const target = path.join(OTHER_SOT, 'custom', 'code-org.md');

    const skipHost = await exported();
    skipHost.files.set(target, 'mine\n');
    const skipped = await runBundleImport(ctxFor(skipHost, OTHER_ROOT), { from: OUT_DIR });
    expect(skipHost.files.get(target)).toBe('mine\n');
    expect(skipped.entries.find((e) => e.path === 'custom/code-org.md')?.action).toBe('skipped');

    const overwriteHost = await exported();
    overwriteHost.files.set(target, 'mine\n');
    await runBundleImport(ctxFor(overwriteHost, OTHER_ROOT), {
      from: OUT_DIR,
      onConflict: 'overwrite',
    });
    expect(overwriteHost.files.get(target)).toBe(
      overwriteHost.files.get(bundleFile('custom/code-org.md')),
    );

    const renameHost = await exported();
    renameHost.files.set(target, 'mine\n');
    const renamed = await runBundleImport(ctxFor(renameHost, OTHER_ROOT), {
      from: OUT_DIR,
      onConflict: 'rename',
    });
    expect(renameHost.files.get(target)).toBe('mine\n');
    // 来料另存为 *.imported（后缀不是 .md → 不参与 sync 的 custom/*.md 装配）
    expect(renameHost.files.get(`${target}.imported`)).toBeDefined();
    expect(renamed.entries.find((e) => e.path === 'custom/code-org.md')?.action).toBe('renamed');
  });

  it('reports bundle files missing from the manifest instead of importing them', async () => {
    const host = await exported();
    host.files.set(bundleFile('custom/stowaway.md'), 'not listed\n');

    const result = await runBundleImport(ctxFor(host, OTHER_ROOT), { from: OUT_DIR });
    expect(result.unlisted).toEqual(['custom/stowaway.md']);
    expect(host.files.has(path.join(OTHER_SOT, 'custom', 'stowaway.md'))).toBe(false);
  });

  it('rejects a directory without manifest.json (exit 2)', async () => {
    const host = seed();
    await expect(
      runBundleImport(ctxFor(host, OTHER_ROOT), { from: abs('nowhere') }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

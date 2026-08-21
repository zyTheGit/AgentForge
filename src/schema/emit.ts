/**
 * 生成 JSON Schema 工件（Draft 2020-12）到 schemas/ 目录（Spec §4）。
 *
 * 用法：npm run emit-schema
 *
 * - io: 'input'：工件用于校验"用户手写的配置文件"，带 .default() 的字段不进入
 *   required 并尽量附带 default 关键字（编辑器悬浮提示可直接展示默认值）；
 * - $id 采用 Spec §4 命名空间 https://agentforge.dev/schema/<id>.json
 *   （实现本地加载，不发起网络请求）；
 * - 写入经 Host（atomicWrite），目录自动创建——工具脚本同样遵守
 *   "core 不直接 import node:fs" 的项目约定；
 * - sources 的 local/git 互斥以 discriminatedUnion + strict 分支表达，
 *   JSON Schema 输出为 anyOf（strict 分支保证恰好一个匹配，语义等价 oneOf）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Host } from '../infra/host';
import { realHost } from '../infra/real-host';
import { atomicWrite, mkdirp } from '../infra/fsutil';
import { HabitsSchema } from './habits';
import { ProfileSchema } from './profile';
import { LearningSchema } from './learning';
import { SourcesFileSchema } from './sources';
import { SyncMetaSchema } from './sync-meta';
import { ManifestSchema } from './manifest';

/** Spec §4 命名空间前缀。 */
const SCHEMA_BASE_ID = 'https://agentforge.dev/schema/';

interface EmitEntry {
  readonly id: string;
  readonly title: string;
  readonly schema: z.ZodType;
}

/** 六个工件与源 schema 的映射（顺序即生成顺序）。 */
const ENTRIES: readonly EmitEntry[] = [
  { id: 'habits', title: 'AgentForge habits.yaml', schema: HabitsSchema },
  { id: 'profile', title: 'AgentForge profile.yaml', schema: ProfileSchema },
  { id: 'learning', title: 'AgentForge learning entry', schema: LearningSchema },
  { id: 'sources', title: 'AgentForge sources.json', schema: SourcesFileSchema },
  { id: 'sync-meta', title: 'AgentForge sync-meta.json', schema: SyncMetaSchema },
  { id: 'manifest', title: 'AgentForge template package manifest.yaml', schema: ManifestSchema },
];

/**
 * 导出全部 JSON Schema 工件到 outDir，返回写入的文件绝对路径列表。
 * 注入 Host 以便单测用内存 fs 验证（不落盘）。
 */
export async function emitSchemas(host: Host, outDir: string): Promise<readonly string[]> {
  await mkdirp(host, outDir);
  const written: string[] = [];
  for (const entry of ENTRIES) {
    const json = z.toJSONSchema(entry.schema, {
      target: 'draft-2020-12',
      io: 'input',
    }) as Record<string, unknown>;
    json.$id = `${SCHEMA_BASE_ID}${entry.id}.json`;
    json.title = entry.title;
    const file = path.join(outDir, `${entry.id}.schema.json`);
    await atomicWrite(host, file, `${JSON.stringify(json, null, 2)}\n`);
    written.push(file);
  }
  return written;
}

// --- CLI 入口（npm run emit-schema）---

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const outDir = path.resolve(import.meta.dirname ?? '.', '..', '..', 'schemas');
  const files = await emitSchemas(realHost, outDir);
  console.log(`emit-schema: 已生成 ${files.length} 个 JSON Schema 工件（Draft 2020-12）`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
}

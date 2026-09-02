/**
 * schema 层汇总导出（Spec §4 / §3.3）。
 *
 * 消费方式：
 * - zod schema：HabitsSchema / ProfileSchema / LearningSchema / SourcesFileSchema /
 *   SyncMetaSchema / ManifestSchema / AdapterSchema（及子 schema 与枚举）；
 * - 类型：完整形态（Habits/Profile/Learning/SourcesFile/SyncMeta/Manifest/AdapterDoc）与
 *   输入形态（*Input，供 core/config 的加载与合并层使用）。
 */
export * from './adapter';
export * from './common';
export * from './habits';
export * from './learning';
export * from './manifest';
export * from './profile';
export * from './sources';
export * from './sync-meta';

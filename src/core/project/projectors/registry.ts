/**
 * Projector 注册表（M6）：四件套统一注册，engine / status / doctor 经此获取。
 *
 * 注册顺序 = Spec §4.2 targets 全集顺序（opencode → codex → claude → pi），
 * list() 的顺序即"无过滤时的默认投影顺序"（engine 事务按此逐一 apply）。
 */
import { Registry } from '../../registry';
import type { Projector } from '../types';
import { claudeProjector } from './claude';
import { codexProjector } from './codex';
import { opencodeProjector } from './opencode';
import { piProjector } from './pi';

/** 全局 projector 注册表（模块加载时完成注册；实例经工厂惰性获取并缓存）。 */
export const projectorRegistry: Registry<Projector> = new Registry<Projector>();

projectorRegistry.register('opencode', () => opencodeProjector);
projectorRegistry.register('codex', () => codexProjector);
projectorRegistry.register('claude', () => claudeProjector);
projectorRegistry.register('pi', () => piProjector);

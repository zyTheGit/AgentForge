/**
 * env 单测（Spec §2.4 环境变量 / USERPROFILE 优先于 HOME）。
 */
import { describe, expect, it } from 'vitest';
import { readEnv } from '../../src/core/env';
import { createFakeHost } from './test-utils';

const envOf = (map: Readonly<Record<string, string>>) => readEnv(createFakeHost(map));

describe('readEnv（Spec §2.4）', () => {
  it('读取全部关注的变量', () => {
    const env = envOf({
      AGF_HOME: 'D:\\af-home',
      AGF_SCOPE: 'user',
      AGF_OFFLINE: '1',
      AGF_LINE_ENDING: 'crlf',
      CI: 'true',
      CODEX_HOME: 'E:\\codex',
      USERPROFILE: 'C:\\Users\\u',
    });
    expect(env).toEqual({
      agfHome: 'D:\\af-home',
      agfScope: 'user',
      offline: true,
      lineEnding: 'crlf',
      ci: true,
      codexHome: 'E:\\codex',
      userProfile: 'C:\\Users\\u',
    });
  });

  it('空环境 → 全部默认值', () => {
    expect(envOf({})).toEqual({
      agfHome: undefined,
      agfScope: undefined,
      offline: false,
      lineEnding: undefined,
      ci: false,
      codexHome: undefined,
      userProfile: undefined,
    });
  });

  it('AGF_OFFLINE 仅严格等于 "1" 时为 true', () => {
    expect(envOf({ AGF_OFFLINE: '1' }).offline).toBe(true);
    expect(envOf({ AGF_OFFLINE: '0' }).offline).toBe(false);
    expect(envOf({ AGF_OFFLINE: 'true' }).offline).toBe(false);
    expect(envOf({ AGF_OFFLINE: '' }).offline).toBe(false);
    expect(envOf({ AGF_OFFLINE: ' 1 ' }).offline).toBe(true); // 前后空白容忍
  });

  it('AGF_SCOPE 仅接受 user | project，非法值降级为 undefined（上层校验）', () => {
    expect(envOf({ AGF_SCOPE: 'user' }).agfScope).toBe('user');
    expect(envOf({ AGF_SCOPE: 'project' }).agfScope).toBe('project');
    expect(envOf({ AGF_SCOPE: 'global' }).agfScope).toBeUndefined();
    expect(envOf({ AGF_SCOPE: '' }).agfScope).toBeUndefined();
  });

  it('AGF_LINE_ENDING 仅接受 lf | crlf，非法值降级为 undefined', () => {
    expect(envOf({ AGF_LINE_ENDING: 'lf' }).lineEnding).toBe('lf');
    expect(envOf({ AGF_LINE_ENDING: 'crlf' }).lineEnding).toBe('crlf');
    expect(envOf({ AGF_LINE_ENDING: 'CR' }).lineEnding).toBeUndefined();
    expect(envOf({ AGF_LINE_ENDING: 'auto' }).lineEnding).toBeUndefined();
  });

  it('CI 真值检测：空/false/0 → false，其余（true/1/任意串）→ true', () => {
    expect(envOf({ CI: 'true' }).ci).toBe(true);
    expect(envOf({ CI: '1' }).ci).toBe(true);
    expect(envOf({ CI: 'github_actions' }).ci).toBe(true);
    expect(envOf({ CI: 'TRUE' }).ci).toBe(true);
    expect(envOf({ CI: 'false' }).ci).toBe(false);
    expect(envOf({ CI: 'False' }).ci).toBe(false);
    expect(envOf({ CI: '0' }).ci).toBe(false);
    expect(envOf({ CI: '' }).ci).toBe(false);
    expect(envOf({}).ci).toBe(false);
  });

  it('USERPROFILE 优先于 HOME（Windows 语义，Spec §2.4）', () => {
    expect(envOf({ USERPROFILE: 'C:\\Users\\u', HOME: '/home/u' }).userProfile).toBe('C:\\Users\\u');
    expect(envOf({ HOME: '/home/u' }).userProfile).toBe('/home/u');
    expect(envOf({ USERPROFILE: '', HOME: '/home/u' }).userProfile).toBe('/home/u');
  });

  it('全空白值视为未设置（trim 语义）', () => {
    const env = envOf({ AGF_HOME: '   ', CODEX_HOME: '\t\n' });
    expect(env.agfHome).toBeUndefined();
    expect(env.codexHome).toBeUndefined();
  });
});

/**
 * errors 单测（Spec §6.1 退出码 / §7.3 严重度聚合）。
 */
import { describe, expect, it } from 'vitest';
import {
  AgentForgeError,
  ConfigError,
  ConflictError,
  ExitCode,
  GenericError,
  OfflineError,
  PermissionError,
  severityOf,
  toExitCode,
} from '../../src/core/errors';

describe('ExitCode 常量（Spec §6.1）', () => {
  it('各退出码数值正确', () => {
    expect(ExitCode.Success).toBe(0);
    expect(ExitCode.Generic).toBe(1);
    expect(ExitCode.Config).toBe(2);
    expect(ExitCode.Conflict).toBe(3);
    expect(ExitCode.Permission).toBe(4);
    expect(ExitCode.Offline).toBe(5);
  });
});

describe('AgentForgeError 基类', () => {
  it('携带 code / message / hint / details', () => {
    const err = new AgentForgeError(ExitCode.Generic, 'boom', {
      hint: 'run aforge doctor',
      details: { raw: true },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentForgeError);
    expect(err.code).toBe(1);
    expect(err.message).toBe('boom');
    expect(err.hint).toBe('run aforge doctor');
    expect(err.details).toEqual({ raw: true });
  });

  it('hint / details 可省略', () => {
    const err = new AgentForgeError(ExitCode.Config, 'bad config');
    expect(err.hint).toBeUndefined();
    expect(err.details).toBeUndefined();
  });
});

describe('错误子类与退出码映射', () => {
  it.each([
    ['GenericError', GenericError, ExitCode.Generic],
    ['ConfigError', ConfigError, ExitCode.Config],
    ['ConflictError', ConflictError, ExitCode.Conflict],
    ['PermissionError', PermissionError, ExitCode.Permission],
    ['OfflineError', OfflineError, ExitCode.Offline],
  ])('%s → code %s', (_name, Ctor, code) => {
    const err = new Ctor('msg');
    expect(err).toBeInstanceOf(AgentForgeError);
    expect(err.code).toBe(code);
    expect(err.message).toBe('msg');
  });

  it('PermissionError 的 hint 是可操作修复建议', () => {
    const err = new PermissionError('无法写入目标文件', {
      hint: '检查文件是否被占用（关闭编辑器 / 等待杀毒扫描结束）、是否只读属性、以及所在目录的写权限',
    });
    expect(err.hint).toMatch(/占用|只读|权限/);
  });
});

describe('severityOf（Spec §7.3：失败 target 取最高严重度）', () => {
  it('投影阶段排序：Permission(4) > Conflict(3) > Generic(1) > Success(0)', () => {
    expect(severityOf(4)).toBeGreaterThan(severityOf(3));
    expect(severityOf(3)).toBeGreaterThan(severityOf(1));
    expect(severityOf(1)).toBeGreaterThan(severityOf(0));
  });

  it('Config(2) fail-fast，不参与投影阶段比较（负权重）', () => {
    expect(severityOf(2)).toBeLessThan(severityOf(1));
  });

  it('Offline(5) 独立域，不参与投影阶段比较（负权重）', () => {
    expect(severityOf(5)).toBeLessThan(severityOf(1));
  });

  it('未知 code 按 Generic 同级处理（安全默认）', () => {
    expect(severityOf(99)).toBe(severityOf(1));
    expect(severityOf(-1)).toBe(severityOf(1));
  });
});

describe('toExitCode', () => {
  it('AgentForgeError → 自身 code', () => {
    expect(toExitCode(new ConfigError('cfg'))).toBe(2);
    expect(toExitCode(new ConflictError('conflict'))).toBe(3);
    expect(toExitCode(new PermissionError('perm'))).toBe(4);
    expect(toExitCode(new OfflineError('offline'))).toBe(5);
    expect(toExitCode(new GenericError('generic'))).toBe(1);
  });

  it('未知错误 → 1（Spec §6.1 通用错误）', () => {
    expect(toExitCode(new Error('plain'))).toBe(1);
    expect(toExitCode('string error')).toBe(1);
    expect(toExitCode(null)).toBe(1);
    expect(toExitCode(undefined)).toBe(1);
    expect(toExitCode({ weird: true })).toBe(1);
  });
});

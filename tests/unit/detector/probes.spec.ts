/**
 * probes 单测：版本文件解析（正常/异常内容边界）+ Shell 启发式。
 */
import { describe, expect, it } from 'vitest';
import {
  detectShell,
  parseNodeVersionFile,
  parsePackageJsonManager,
  parsePyproject,
  parsePythonVersionFile,
} from '../../../src/core/detector/probes';
import { createFakeHost } from '../test-utils';

describe('parseNodeVersionFile', () => {
  it('普通版本', () => {
    expect(parseNodeVersionFile('22.11.0')).toBe('22.11.0');
  });

  it('v 前缀剥离 + 尾部换行', () => {
    expect(parseNodeVersionFile('v22.11.0\n')).toBe('22.11.0');
  });

  it('CRLF 与注释行：取首个非注释行', () => {
    expect(parseNodeVersionFile('# pinned by ci\r\n\r\n22.1.0\r\n')).toBe('22.1.0');
  });

  it('空内容 → undefined', () => {
    expect(parseNodeVersionFile('')).toBeUndefined();
  });

  it('纯注释 → undefined', () => {
    expect(parseNodeVersionFile('# only comment\n')).toBeUndefined();
  });

  it('全空白 → undefined', () => {
    expect(parseNodeVersionFile('   \n  \t ')).toBeUndefined();
  });
});

describe('parsePythonVersionFile', () => {
  it('普通版本（含次要版本）', () => {
    expect(parsePythonVersionFile('3.12.1\n')).toBe('3.12.1');
  });

  it('主版本', () => {
    expect(parsePythonVersionFile('3.12')).toBe('3.12');
  });

  it('v 前缀剥离', () => {
    expect(parsePythonVersionFile('v3.12')).toBe('3.12');
  });

  it('坏内容 → undefined', () => {
    expect(parsePythonVersionFile('\n\n')).toBeUndefined();
  });
});

describe('parsePackageJsonManager', () => {
  it('"pnpm@9.1.0" → manager + version', () => {
    expect(parsePackageJsonManager('{"packageManager": "pnpm@9.1.0"}')).toEqual({
      manager: 'pnpm',
      version: '9.1.0',
    });
  });

  it('"npm"（无版本）→ version undefined', () => {
    expect(parsePackageJsonManager('{"packageManager": "npm"}')).toEqual({
      manager: 'npm',
      version: undefined,
    });
  });

  it('corepack 完整性后缀（+sha256-...）剥掉', () => {
    expect(parsePackageJsonManager('{"packageManager": "yarn@4.1.1+sha256.xxx"}')).toEqual({
      manager: 'yarn',
      version: '4.1.1',
    });
  });

  it('无 packageManager 字段 → undefined', () => {
    expect(parsePackageJsonManager('{"name": "x", "version": "1.0.0"}')).toBeUndefined();
  });

  it('非法 JSON → undefined', () => {
    expect(parsePackageJsonManager('not a json')).toBeUndefined();
  });

  it('非字符串值 → undefined', () => {
    expect(parsePackageJsonManager('{"packageManager": 123}')).toBeUndefined();
  });

  it('空字符串值 → undefined', () => {
    expect(parsePackageJsonManager('{"packageManager": "  "}')).toBeUndefined();
  });

  it('非对象顶层 → undefined', () => {
    expect(parsePackageJsonManager('[1,2]')).toBeUndefined();
  });
});

describe('parsePyproject', () => {
  it('[tool.poetry] 段 → poetry', () => {
    expect(parsePyproject('[tool.poetry]\nname = "x"\n')).toBe('poetry');
  });

  it('[tool.uv] 段 → uv', () => {
    expect(parsePyproject('[project]\nname = "x"\n\n[tool.uv]\n')).toBe('uv');
  });

  it('[tool.pipenv] 段 → pipenv', () => {
    expect(parsePyproject('[tool.pipenv]\n')).toBe('pipenv');
  });

  it('子表（[tool.uv.workspace]）隐含父段 → uv', () => {
    expect(parsePyproject('[tool.uv.workspace]\nmembers = []\n')).toBe('uv');
  });

  it('多段同时存在按 uv > poetry > pipenv 取', () => {
    expect(parsePyproject('[tool.poetry]\n\n[tool.uv]\n')).toBe('uv');
    expect(parsePyproject('[tool.pipenv]\n\n[tool.poetry]\n')).toBe('poetry');
  });

  it('无 tool 段 → undefined', () => {
    expect(parsePyproject('[project]\nname = "x"\n')).toBeUndefined();
  });

  it('字符串中出现 tool.uv 不算段头（含 TOML 注释）', () => {
    expect(parsePyproject('# [tool.uv]\nnote = "uses [tool.uv] style"\n')).toBeUndefined();
  });
});

describe('detectShell', () => {
  describe('win32', () => {
    it('PSModulePath 存在 → powershell', () => {
      const host = createFakeHost({ PSModulePath: 'C:\\Users\\x\\Documents\\PowerShell\\Modules' });
      expect(detectShell(host, 'win32')).toBe('powershell');
    });

    it('POWERSHELL_DISTRIBUTION_CHANNEL 存在 → pwsh（优先于 PSModulePath）', () => {
      const host = createFakeHost({
        POWERSHELL_DISTRIBUTION_CHANNEL: 'MSI:Windows 11 Pro',
        PSModulePath: 'C:\\...',
      });
      expect(detectShell(host, 'win32')).toBe('pwsh');
    });

    it('ComSpec 含 cmd.exe → cmd', () => {
      const host = createFakeHost({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
      expect(detectShell(host, 'win32')).toBe('cmd');
    });

    it('全空白 PSModulePath 不算数 → 落到 ComSpec 分支', () => {
      const host = createFakeHost({
        PSModulePath: '   ',
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      });
      expect(detectShell(host, 'win32')).toBe('cmd');
    });

    it('Git Bash 导出 SHELL → bash（优先于 PowerShell 启发式）', () => {
      const host = createFakeHost({
        SHELL: '/usr/bin/bash',
        PSModulePath: 'C:\\...',
      });
      expect(detectShell(host, 'win32')).toBe('bash');
    });

    it('无线索 → other', () => {
      expect(detectShell(createFakeHost({}), 'win32')).toBe('other');
    });
  });

  describe('posix', () => {
    it('SHELL basename 映射', () => {
      expect(detectShell(createFakeHost({ SHELL: '/bin/zsh' }), 'linux')).toBe('zsh');
      expect(detectShell(createFakeHost({ SHELL: '/usr/bin/bash' }), 'linux')).toBe('bash');
      expect(detectShell(createFakeHost({ SHELL: '/usr/local/bin/fish' }), 'darwin')).toBe('fish');
      expect(detectShell(createFakeHost({ SHELL: '/bin/nu' }), 'linux')).toBe('nushell');
    });

    it('未知 shell → other', () => {
      expect(detectShell(createFakeHost({ SHELL: '/bin/tcsh' }), 'linux')).toBe('other');
    });

    it('SHELL 未设置 → other', () => {
      expect(detectShell(createFakeHost({}), 'linux')).toBe('other');
    });

    it('SHELL 全空白 → other', () => {
      expect(detectShell(createFakeHost({ SHELL: '  ' }), 'linux')).toBe('other');
    });
  });
});

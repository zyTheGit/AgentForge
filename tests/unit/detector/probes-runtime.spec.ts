/**
 * probes-runtime 单测：java / dotnet 的版本文件解析（正常与畸形内容边界）
 * + 两个判定函数的分支（sdkman 的 env/文件双线索、javac 回落、global.json 无 sdk 段）。
 */
import { describe, expect, it } from 'vitest';
import {
  detectDotnet,
  detectJava,
  JAVA_MANAGER_PRIORITY,
  parseGlobalJsonSdkVersion,
  parseJavaVersionFile,
  parseSdkmanrcJava,
  RUNTIME_SCAN_NAMES,
} from '../../../src/core/detector/probes-runtime';

/** 便于逐个用例构造 PATH 命中表（name → 绝对路径）。 */
function hitsOf(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

describe('parseJavaVersionFile', () => {
  it('普通版本', () => {
    expect(parseJavaVersionFile('21.0.2')).toBe('21.0.2');
  });

  it('v 前缀剥离 + 尾部换行', () => {
    expect(parseJavaVersionFile('v21.0.2\n')).toBe('21.0.2');
  });

  it('发行商前缀原样保留（jenv 会写 temurin-17.0.9 这种）', () => {
    expect(parseJavaVersionFile('temurin-17.0.9\n')).toBe('temurin-17.0.9');
  });

  it('CRLF 与注释行：取首个非注释行', () => {
    expect(parseJavaVersionFile('# pinned\r\n\r\n17\r\n')).toBe('17');
  });

  it('空内容 / 纯注释 / 全空白 → undefined', () => {
    expect(parseJavaVersionFile('')).toBeUndefined();
    expect(parseJavaVersionFile('# only comment\n')).toBeUndefined();
    expect(parseJavaVersionFile('  \n\t')).toBeUndefined();
  });
});

describe('parseSdkmanrcJava', () => {
  it('java=<identifier> → 原样（不剥发行商后缀）', () => {
    expect(parseSdkmanrcJava('java=21.0.2-tem\n')).toBe('21.0.2-tem');
  });

  it('多键共存只取 java', () => {
    expect(parseSdkmanrcJava('# sdkman\nmaven=3.9.6\njava=17.0.9-graalce\ngradle=8.7\n')).toBe(
      '17.0.9-graalce',
    );
  });

  it('大小写与空格容错', () => {
    expect(parseSdkmanrcJava('  JAVA  =  17-open  \n')).toBe('17-open');
  });

  it('注释掉的 java= 不算', () => {
    expect(parseSdkmanrcJava('# java=8.0.402-tem\nmaven=3.9.6\n')).toBeUndefined();
  });

  it('无 java 键 / 空内容 / 空值 → undefined', () => {
    expect(parseSdkmanrcJava('maven=3.9.6\n')).toBeUndefined();
    expect(parseSdkmanrcJava('')).toBeUndefined();
    expect(parseSdkmanrcJava('java=\n')).toBeUndefined();
    expect(parseSdkmanrcJava('java=   \n')).toBeUndefined();
  });
});

describe('parseGlobalJsonSdkVersion', () => {
  it('sdk.version → 版本字符串', () => {
    expect(parseGlobalJsonSdkVersion('{"sdk":{"version":"8.0.100"}}')).toBe('8.0.100');
  });

  it('多余字段与空白不影响', () => {
    expect(
      parseGlobalJsonSdkVersion(
        '{\n "sdk": { "version": " 9.0.101 ", "rollForward": "latestPatch" }\n}',
      ),
    ).toBe('9.0.101');
  });

  it('非法 JSON → undefined', () => {
    expect(parseGlobalJsonSdkVersion('{"sdk":{')).toBeUndefined();
    expect(parseGlobalJsonSdkVersion('not a json')).toBeUndefined();
  });

  it('无 sdk 段（只钉 msbuild-sdks）→ undefined', () => {
    expect(parseGlobalJsonSdkVersion('{"msbuild-sdks":{"x":"1.0.0"}}')).toBeUndefined();
  });

  it('sdk 非对象 / version 非字符串 / version 空白 → undefined', () => {
    expect(parseGlobalJsonSdkVersion('{"sdk":"8.0.100"}')).toBeUndefined();
    expect(parseGlobalJsonSdkVersion('{"sdk":null}')).toBeUndefined();
    expect(parseGlobalJsonSdkVersion('{"sdk":{"version":8}}')).toBeUndefined();
    expect(parseGlobalJsonSdkVersion('{"sdk":{"version":"  "}}')).toBeUndefined();
  });

  it('非对象顶层 → undefined', () => {
    expect(parseGlobalJsonSdkVersion('[1,2]')).toBeUndefined();
    expect(parseGlobalJsonSdkVersion('null')).toBeUndefined();
  });
});

const NO_JAVA_CLUES = {
  version: undefined,
  hasVersionFile: false,
  hasSdkmanrc: false,
  hasSdkmanDir: false,
} as const;

describe('detectJava', () => {
  it('sdkman 优先级最高：.sdkmanrc 命中时压过 PATH 上的 jenv', () => {
    expect(
      detectJava(hitsOf({ jenv: '/usr/bin/jenv', java: '/usr/bin/java' }), {
        ...NO_JAVA_CLUES,
        version: '21.0.2-tem',
        hasVersionFile: true,
        hasSdkmanrc: true,
      }),
    ).toEqual({
      manager: 'sdkman',
      source: 'version-file',
      version: '21.0.2-tem',
      path: '/usr/bin/java',
    });
  });

  it('只有 SDKMAN_DIR（无 .sdkmanrc）→ source 记 env', () => {
    expect(detectJava(hitsOf({}), { ...NO_JAVA_CLUES, hasSdkmanDir: true })).toEqual({
      manager: 'sdkman',
      source: 'env',
    });
  });

  it('PATH 命中优先级 jenv > jabba > mise > asdf', () => {
    const cases: Array<[string[], string]> = [
      [['jenv', 'jabba'], 'jenv'],
      [['jabba', 'mise'], 'jabba'],
      [['mise', 'asdf'], 'mise'],
      [['asdf'], 'asdf'],
    ];
    for (const [names, expected] of cases) {
      const hits = hitsOf(Object.fromEntries(names.map((n) => [n, `/usr/bin/${n}`])));
      expect(detectJava(hits, NO_JAVA_CLUES).manager, names.join(',')).toBe(expected);
    }
  });

  it('仅 JDK（javac 在 PATH、java 不在）→ system + javac 路径', () => {
    expect(detectJava(hitsOf({ javac: '/opt/jdk/bin/javac' }), NO_JAVA_CLUES)).toEqual({
      manager: 'system',
      source: 'path',
      path: '/opt/jdk/bin/javac',
    });
  });

  it('.java-version 存在但无本体 → manager none + source version-file', () => {
    expect(
      detectJava(hitsOf({}), { ...NO_JAVA_CLUES, version: '17', hasVersionFile: true }),
    ).toEqual({ manager: 'none', source: 'version-file', version: '17' });
  });

  it('无任何线索 → none', () => {
    expect(detectJava(hitsOf({}), NO_JAVA_CLUES)).toEqual({ manager: 'none', source: 'none' });
  });
});

describe('detectDotnet', () => {
  it('global.json + dotnet 本体 → system + version', () => {
    expect(
      detectDotnet(hitsOf({ dotnet: '/usr/bin/dotnet' }), {
        version: '8.0.100',
        hasGlobalJson: true,
      }),
    ).toEqual({
      manager: 'system',
      source: 'version-file',
      version: '8.0.100',
      path: '/usr/bin/dotnet',
    });
  });

  it('global.json 解析不出版本仍算线索（manager 按本体推断）', () => {
    expect(detectDotnet(hitsOf({}), { version: undefined, hasGlobalJson: true })).toEqual({
      manager: 'none',
      source: 'version-file',
    });
  });

  it('仅 dotnet 本体 → system + path', () => {
    expect(
      detectDotnet(hitsOf({ dotnet: '/usr/bin/dotnet' }), {
        version: undefined,
        hasGlobalJson: false,
      }),
    ).toEqual({ manager: 'system', source: 'path', path: '/usr/bin/dotnet' });
  });

  it('无线索 → none', () => {
    expect(detectDotnet(hitsOf({}), { version: undefined, hasGlobalJson: false })).toEqual({
      manager: 'none',
      source: 'none',
    });
  });
});

describe('候选与扫描名常量', () => {
  it('JAVA_MANAGER_PRIORITY 以 sdkman 起头，其余四个与 PATH 扫描名一致', () => {
    expect([...JAVA_MANAGER_PRIORITY]).toEqual(['sdkman', 'jenv', 'jabba', 'mise', 'asdf']);
    for (const manager of JAVA_MANAGER_PRIORITY.slice(1)) {
      expect(RUNTIME_SCAN_NAMES, `${manager} 应在 PATH 扫描名内`).toContain(manager);
    }
    // sdkman 的 `sdk` 是 shell 函数，刻意不扫 PATH
    expect(RUNTIME_SCAN_NAMES).not.toContain('sdk');
    expect(RUNTIME_SCAN_NAMES).not.toContain('sdkman');
  });

  it('本体可执行名并入扫描集（java / javac / dotnet）', () => {
    expect(RUNTIME_SCAN_NAMES).toContain('java');
    expect(RUNTIME_SCAN_NAMES).toContain('javac');
    expect(RUNTIME_SCAN_NAMES).toContain('dotnet');
  });
});

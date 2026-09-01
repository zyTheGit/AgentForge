# 安装与构建

## 方式一：npx 直接用（推荐，无需克隆）

前置：Node ≥ 20.19。

```powershell
# 免安装试跑（每次拉最新版；@latest 用于绕开 npx 的本地缓存）
npx -y @zythegit/agentforge@latest --version
npx -y @zythegit/agentforge@latest init

# 常用则全局装，之后直接 aforge
npm i -g @zythegit/agentforge
aforge --version
```

包名是 `@zythegit/agentforge`，命令名是 `aforge`。发布产物是 esbuild 打出的单文件 bundle（依赖已内联），因此 `npx` 冷启动只下载一个文件，不再安装任何运行时依赖。

## 方式二：下载独立二进制（免 Node，兜底）

只有在目标机器装不了 Node 时才需要这条路：二进制内嵌了 bun 运行时，压缩包 36~39 MB（解包后 64~86 MB），比 npm 包大两个数量级。

从 [Releases](https://github.com/zyTheGit/AgentForge/releases) 下载对应平台的压缩包（附 `checksums.txt`，内容是**压缩包**的 sha256）：

| 平台 | 资产 |
| --- | --- |
| Windows x64 | `aforge-win32-x64.zip` |
| Linux x64 / arm64 | `aforge-linux-x64.tar.gz` / `aforge-linux-arm64.tar.gz` |
| macOS Apple Silicon / Intel | `aforge-darwin-arm64.tar.gz` / `aforge-darwin-x64.tar.gz` |

解包后重命名为 `aforge`（Windows 为 `aforge.exe`）放进 PATH 即可。

macOS 上二进制未做签名与公证，首次运行会被 Gatekeeper 拦下，需手动去掉隔离属性：

```bash
xattr -d com.apple.quarantine ./aforge
```

`aforge-linux-arm64` 在 CI 里只靠 QEMU 模拟跑过 `--version`，没有 arm64 真机验证；`aforge-darwin-x64` 既无免费 runner 也无法用容器模拟，属于「已交叉编译但完全未冒烟」。

## 方式三：从源码构建

前置：安装 [bun](https://bun.sh/) 与 [fnm](https://github.com/Schniz/fnm)（或任意 Node 版本管理器）。

```powershell
# 每个新终端先激活 Node 环境（fnm）
fnm env --shell power-shell | Out-String -Stream | Invoke-Expression
fnm use 22

git clone https://github.com/zyTheGit/AgentForge.git
cd AgentForge
npm install

npm run build:node    # 产出 dist\aforge.js（esbuild 打包压缩，需 Node ≥ 20.19）
npm run build:bun     # 产出当前平台的单文件二进制（dist\aforge-win32-x64.exe 等）
npm run build:bun:all # 交叉编译五平台（win32-x64 / linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64）
bun link              # 之后任意目录可用 aforge 命令
```

两条构建轨道功能等价、分发形态不同：二进制零依赖可直接分发，代价是体积；`aforge.js` 需要既有 Node 环境，也是 npm 包实际发布的产物。

## 开发

```powershell
fnm env --shell power-shell | Out-String -Stream | Invoke-Expression
fnm use 22
npm install
npm test           # 全量测试（vitest）
npm run typecheck  # tsc --noEmit
npm run lint       # biome + 文件行数卡口（单个 src/*.ts <= 500 行）
npm run build      # 双轨构建（node + bun）
```

验收清单见 [tests/e2e/ACCEPTANCE.md](../tests/e2e/ACCEPTANCE.md)；协作流程（分支 + PR、提交前三项全绿）见 [AGENTS.md](../AGENTS.md)。

## macOS / Linux 旁注

- 首选装法与 Windows 一致：`npx -y @zythegit/agentforge@latest`（或 `npm i -g`）；
- 从源码构建：`fnm env --shell bash | source -`（或 zsh）后 `npm install` + `npm run build:node`；
- 用户级 SoT 在 `$HOME/.agentforge`；投影换行默认规则同 Windows（profile 可配置）；
- WSL 内的安装与原生 Linux 完全一致（AgentForge 不检测 WSL）；SoT 该放哪一侧、以及两侧混用的坑见 [平台注意事项 · WSL 互通](platform.md#wsl-互通)；
- `npm run build:bun` 自动按当前平台选 target，`build:bun:all` 一次交叉编译五平台；
- macOS 二进制未签名未公证，见上文「方式二」的 `xattr` 说明。

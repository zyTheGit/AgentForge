# 迁移 SoT（换机器 / 备份 / 复制到另一个项目）

`aforge bundle export` 把**一层** SoT 打成一个可搬走的目录，`bundle import` 把它落回另一层。注意与 `aforge import <path>`（从既有 AGENTS.md 抽工具链声明）不是一回事，两者刻意分开命名。

```powershell
# 旧机器：导出 project 层
aforge bundle export --out D:\agf-bundle
#   产物：D:\agf-bundle\manifest.json + D:\agf-bundle\sot\...

# 新机器：落回（不需要先 init，目录会自动创建）
aforge bundle import --from D:\agf-bundle
aforge detect      # 重建本机工具链快照
aforge sync        # 投影到四个目标
```

## 参数

| 参数 | 用在 | 说明 |
|------|------|------|
| `--out <dir>` | export | 必填。输出目录，相对当前目录解析；必须为空或不存在 |
| `--from <dir>` | import | 必填。`bundle export` 产出的目录（其下应有 `manifest.json` 与 `sot/`） |
| `--scope project\|user` | 两者 | export 缺省按有效 scope；import 缺省 `AGF_SCOPE` → `project`。两端可以不同层：`export --scope user` 后 `import --scope project` 就是把用户层内容复制进项目层 |
| `--no-redact` | export | 原样带走 MCP 凭据（缺省抹成占位符）。此时 bundle 本身即密钥载体，别放进 git |
| `--keep-detected` | export | 保留 `habits.detected`（缺省剔除） |
| `--on-conflict skip\|overwrite\|rename` | import | 目标已存在同名文件时的策略，缺省 `skip`。拼错**不会**静默退化成缺省值，直接退出码 2 |
| `--json` | 两者 | 机器可读输出（绝对路径）。人类可读输出里超过 20 条的清单会折叠，要全量就用这个 |

常见用法：

```powershell
# 只想备份用户层（含 store/ 之外的全部沉淀）
aforge bundle export --scope user --out D:\agf-user-backup

# 目标已有内容、又不想丢自己的改动：两份都留着自己合并
aforge bundle import --from D:\agf-bundle --on-conflict rename

# 先看清楚会写哪些文件（--json 输出 entries[].target 是绝对路径）
aforge --json bundle import --from D:\agf-bundle
```

## 带走什么、留下什么

由 `core/bundle/layout` 的分类表决定，`manifest.excluded` 会逐条报出原因：

- **带走**：`habits.yaml`、`profile.yaml`、`sources.json`、`custom/`、`learnings/`（含未 promote 的条目）、`templates/`、`skills/`、`mcp/`；
- **剔除 `sync-meta.json`**（`machine-state`）：里面是上一轮产物的**绝对路径 + prune 白名单**，换机器后基准是错的；
- **剔除 `.sync.lock` / `.agf-backup*`**（`transient`）：事务残留；
- **剔除 `store/`**（`cache`）：user 层的 git 源 clone，`aforge source update` 可重建；
- **剔除 `habits.detected`**：本机探测快照，`aforge detect` 一条命令重建（要留就加 `--keep-detected`）；
- **其它非布局条目**（你随手放在 SoT 里的文件）报为 `not-part-of-sot`，既不带走也不静默丢弃。

## 安全与完整性

- **默认抹掉 MCP 凭据**：`mcp.servers[].env` / `.headers` 的值换成占位符，字段路径记进 `manifest.redacted`，`import` 时会打出来提醒你重新填。真要原样带走密钥加 `--no-redact`。注意 redact **只覆盖这两处**——凭据若内联在 `command` / `args` / `url` 里（`--token xxx`、`https://user:pass@host`），形状不可知、抹不了，export 会在 warnings 里提示你自己过一遍；
- **import 先校验后落盘**：逐个文件比对 `manifest` 里的 sha256（LF 规范化，经 git / 压缩包搬运不会误报），任一处不符 → 退出码 2 且**一个字节都不写**；
- **manifest 按不可信输入对待**（它是可手工编辑的普通文件）：`files[].path` 含 `..` / 绝对路径 / 盘符一律拒绝；首段不属于「带走」集合的也拒绝——`sync-meta.json` 这类被 export 剔除的本机状态**不接受反向导入**，否则下一次 `sync` 会照着别的机器的 prune 白名单删本机文件；
- **symlink 一律不跟随**：export 遇到 symlink（含顶层带走目录自身是 symlink）跳过并报进 warnings；import 在写第一个字节之前确认目标路径链上没有 symlink，有则退出码 2——防的是「SoT 里的 `custom/` 是条指向别处的链接，合法相对路径被穿透写到链接目标」；
- **默认不覆盖你的文件**：冲突策略缺省 `skip`，可选 `--on-conflict overwrite`（替换）或 `rename`（来料另存为 `<name>.imported`，两份都留着自己合并）；
- `import` 全程持 SoT 事务锁（与 `sync` 同一把），但**不会自动 sync**——填 SoT 与写别人的文件是两件事。

退出码：`2` 配置/校验类（未 init、`--out` 落在 SoT 内、manifest 坏或路径越界、哈希不符、路径链上有 symlink、`--on-conflict` 取值非法）；`3` 冲突类（`--out` 非空、SoT 锁被他人持有、`rename` 落点耗尽）；`4` 权限类（目标不可写）。

已知取舍：`habits.yaml` / `profile.yaml` 经「解析 → 净化 → 重新序列化」往返，**YAML 注释会丢**（同 `skill add` 写 profile 的代价）；`--no-redact --keep-detected` 时两份文件走原文直拷，注释保留。内容一律按 UTF-8 文本处理，二进制附属文件不在支持范围内。bundle 目录是可丢弃产物，写到一半失败就删掉重跑。契约细节见 Spec §7.9。

# 安装与使用 skill

`aforge skill add` 接的是**技能名**，不是 URL——URL 要先 `aforge source add` 登记成「源」，再按名安装。以装 vercel-labs/skills 里的 `find-skills` 为例：

```powershell
# ① 登记 git 源（必须显式 --ref，Spec 不跟踪浮动分支）
aforge source add https://github.com/vercel-labs/skills --ref main
#   clone 到 %USERPROFILE%\.agentforge\store\skills；id 由 basename 派生为 "skills"
#   想自定义 id 加 --id vercel-skills

# ② 看源里有哪些技能可装（status=available 的条目）
aforge skill list

# ③ 按名安装：实体拷贝到 SoT 的 skills\find-skills\
aforge skill add find-skills --from skills
```

`--from` 可省略（按登记顺序在所有启用的源中找首个含该技能的源），也可直接传路径而完全跳过 `source add`——传源根目录（其下有 `skills\<name>\`）或直接传含 `SKILL.md` 的技能目录本身：

```powershell
aforge skill add find-skills --from D:\clones\vercel-labs-skills   # 源根
aforge skill add my-skill --from .\drafts\my-skill                 # 技能目录本身
```

`skill add` 除了把文件拷进 `.agentforge\skills\`，还会把技能名登记进**同一层** `profile.yaml` 的 `skills.always`（幂等，重复 add 不会写重名），所以装完直接 `sync` 就能投影：

```yaml
# .agentforge\profile.yaml（skill add 自动维护）
skills:
  copy_mode: copy
  always:
    - find-skills
```

```powershell
aforge sync
```

注意：凡是会写 `profile.yaml` 的命令（`skill add`、`skill remove`、`mcp add`、`mcp remove`、`template enable`）都是整份重新序列化，YAML 注释、空行和行内数组写法（`targets: [claude]`）会丢失，键顺序变成程序内部顺序——手写过的 `profile.yaml` 被这些命令改过后格式会变。

只想拷文件、自己手工编排 `profile.yaml` 的话加 `--no-register`：

```powershell
aforge skill add find-skills --no-register
```

## 投影落点与调用前缀

project scope 下投影 `SKILL.md` 正文，各 target 的调用前缀不同（Spec §8.8，实测结论）：

| target | 落点 | 会话里怎么调 |
|---|---|---|
| opencode | `.opencode\skills\<name>\SKILL.md` | `/<name>` |
| codex | `.agents\skills\<name>\SKILL.md` | **`$<name>`** |
| claude | `.claude\skills\<name>\SKILL.md` | `/<name>` |
| pi | `.pi\skills\<name>\SKILL.md` | `/<name>` |

codex 是四家里唯一用 `$` 的，`/<name>` 不展开。`aforge skill add` 的成功提示与 `aforge status` 都会打印前缀（前者按技能名给出可直接复制的调用形式），不必记。

要点：

- 源仓库布局须为 `<源根>\skills\<name>\SKILL.md`；
- 目标 `skills\<name>` 已有内容 → 退出码 3，先手删该目录再装；
- 源里的 symlink 一律跳过不跟随（防私钥等被读进 SoT），跳过项在输出的 `skipped` 里列出；
- `skills.always` 点了名却没装 → `sync` 直接报错退出码 2；
- 装到 user 层时注意 §5.3 合并语义：`merge.arrays: replace`（缺省）下 project 层自己写了 `skills.always` 就会整体覆盖 user 层那份；
- 附属文件（脚本、参考资料）会拷进 SoT，但当前只有 `SKILL.md` 正文参与投影。

## 注销技能

不想再让某个技能被投影时用 `skill remove`——它**只**把名字从该层 `profile.yaml` 的 `skills.always` 摘掉，`skills\<name>\` 目录原样留在磁盘上：

```powershell
aforge skill remove find-skills
# skill removed: find-skills (profile only)
#   scope     : project
#   profile   : D:\proj\.agentforge\profile.yaml
#   always    : pdf-tools
#   skill dir : D:\proj\.agentforge\skills\find-skills (kept on disk)
#
# note: removed from profile.yaml only. run `aforge sync` to drop the
#       projected copies (project level):
#         D:\proj\.opencode\skills\find-skills\SKILL.md
#         D:\proj\.agents\skills\find-skills\SKILL.md
#         D:\proj\.claude\skills\find-skills\SKILL.md
#         D:\proj\.pi\skills\find-skills\SKILL.md
#       manually edited copies are kept and listed under `prune skipped`.
```

- **投影产物由下一次 `aforge sync` 清理。** 摘除只作用于 SoT；再跑一次 `sync` 会按上一轮记账（`sync-meta.json` 的 `artifacts`）删掉 `.claude\skills\<name>\SKILL.md`（`.opencode` / `.agents` / `.pi` 同理），并在输出的 `pruned` 里列出。只删内容仍与记账一致的文件——手工改过的那份会保留并报进 `prune skipped`，详见 Spec §7.6；
- `--scope project|user` 指定改哪一层（缺省同 `add`：AGF_SCOPE > project 在用 > user 在用）；两层都登记了同名技能时要各删一次；
- 该层 `skills.always` 里没有这个名字 → 退出码 2（不当成幂等成功，多半是层选错了）。错误提示会说明目录是否还在盘上；如果另一层登记了同名，提示会直接给出可复制的 `--scope <另一层>`；
- 摘完 `always` 只剩空数组时那一行显示 `(none)`；注意 `merge.arrays: replace` 下空数组**仍会覆盖** user 层，要让 user 层的同名技能重新生效得手工删掉 project 层的整个 `skills.always` 键；
- 要腾空间 / 想重装，删完登记后手工删除 `skills\<name>\`（`skill add` 遇到已存在且非空的目录会报退出码 3）。

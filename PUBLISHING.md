# 手动发布手册（unireq / varjson）

**适用对象**：维护者。`unireq` 与 `varjson` 都**不使用 CI 自动发包**，也不配置 `NPM_TOKEN`：

- GitHub Actions 只在 push tag `v*` 时构建、`npm pack` 留档、创建 GitHub Release（vjson 额外打 VSIX）；
- `npm publish` 由维护者在本地手动执行。

两个包必须在 **npm 官方 registry** 上发布；本机若配置了镜像源，命令必须显式带 `--registry https://registry.npmjs.org`。

> 同一份手册也存放在 varjson 仓库的 `docs/PUBLISHING.md`。

---

## 1. 发包前检查（每次发布都做）

```powershell
# 1) 登录状态：必须返回你的 npm 用户名；E401 表示未登录或 token 失效
npm whoami --registry https://registry.npmjs.org

# 2) 确认 registry 不是镜像源
npm config get registry

# 3) 包名是否已被占用：404 = 没人用；返回版本列表 = 已被占用
npm view unireq name version --registry https://registry.npmjs.org
npm view varjson name version --registry https://registry.npmjs.org

# 4) 查看已发布历史，避免重复版本
npm view unireq versions --json --registry https://registry.npmjs.org
npm view varjson versions --json --registry https://registry.npmjs.org

# 5) 打包清单与体积（不会真的写 tarball）
npm pack --dry-run
```

判断规则：

- `npm view <name>` 返回 **404 / E404**：这个名字在公共 registry 上可用。
- 返回任何版本：**已被占用**。不要换账号硬发，也不要擅自改 `package.json`；先报告，再决定是否改成 scope 包（例如 `@deepl-ysp/varjson`）。
- `npm pack --dry-run` 必须确认：只包含 `dist/`、`README.md`、`package.json`（vjson 还有 `LICENSE`），**不包含** `vendor/`、`node_modules/`、测试或源码。
- 如果 npm 要求一次性密码，在 publish 时加 `--otp=123456`。

---

## 2. 版本号与 Git tag 规则（硬性）

`package.json` 的 `version` 必须与推送的 tag 完全一致：

| package.json | Git tag |
|---|---|
| `0.2.0` | `v0.2.0` |
| `1.2.3` | `v1.2.3` |

不一致的后果：`npm publish` 会因版本已存在而 `403`，CI 触发的也是错误版本的构建。改版本用 npm 命令避免手滑：

```powershell
npm version patch --no-git-tag-version   # 0.1.0 -> 0.1.1（修复）
npm version minor --no-git-tag-version   # 0.1.0 -> 0.2.0（向后兼容新功能）
npm version major --no-git-tag-version   # 1.0.0（破坏性变更）
```

`--no-git-tag-version` 表示只改文件，commit 与 tag 由下面的流程显式执行。

---

## 3. unireq 发布流程（先发 unireq）

```powershell
cd c:\project\varJson\unireq

# 1) 改版本（示例：0.1.0 -> 0.2.0）
npm version minor --no-git-tag-version

# 2) 让 package-lock 的根版本同步
npm install --package-lock-only --ignore-scripts

# 3) 构建与验证
npm run typecheck
npm test
npm run build

# 4) 检查发布清单（必须只含 dist/ + README.md + package.json）
npm pack --dry-run

# 5) 手动发布到官方 registry
npm publish --access public --registry https://registry.npmjs.org

# 6) 提交、打 tag、推送
git status
git add package.json package-lock.json src test tsconfig.json tsconfig.build.json tsconfig.test.json .github/workflows PUBLISHING.md
git commit -m "release: unireq v0.2.0"
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

推送 tag 后，GitHub Actions 的 `Release` 会构建并创建对应的 GitHub Release，附上 `unireq-0.2.0.tgz`。

---

## 4. vjson 发布流程（后发 vjson）

vjson 的 `devDependencies.unireq` 指向仓库内的 `vendor/unireq` 快照（供干净 checkout 安装与测试），
而发布产物只声明 **可选 peer 依赖**。因此顺序必须是：**先发布 unireq → 再刷新 vendor → 再发布 vjson**。

### 4.1 刷新 vendor 快照

```powershell
$src = 'c:\project\varJson\unireq'
$dst = 'c:\project\varJson\vjson\vendor\unireq'

# 1) 用刚构建好的 dist 覆盖旧快照
Remove-Item -LiteralPath "$dst\dist" -Recurse -Force
Copy-Item -LiteralPath "$src\dist" -Destination "$dst\dist" -Recurse
Copy-Item -LiteralPath "$src\package.json" -Destination "$dst\package.json" -Force
Copy-Item -LiteralPath "$src\README.md" -Destination "$dst\README.md" -Force -ErrorAction SilentlyContinue

# 2) vendored package.json 只保留运行所需字段，去掉开发期脚本与 devDependencies
$pkg = Get-Content "$dst\package.json" -Raw | ConvertFrom-Json
$pkg.PSObject.Properties.Remove('scripts')
$pkg.PSObject.Properties.Remove('devDependencies')
$pkg | ConvertTo-Json -Depth 10 | Set-Content "$dst\package.json" -Encoding utf8

# 3) 确认快照版本与 unireq 一致
(Get-Content "$dst\package.json" -Raw | ConvertFrom-Json).version
```

### 4.2 同步 lock 并验证

vendor 的版本变了，`package-lock.json` 里 `vendor/unireq` 的版本也要随之更新：

```powershell
cd c:\project\varJson\vjson
npm install --package-lock-only --ignore-scripts
npm ci
npx tsc --noEmit
npm test
npm run build
```

同时检查 vjson 的 `peerDependencies.unireq` 范围是否覆盖新版本（例如 unireq 升到 `0.2.x` 时写 `>=0.2.0`）。

### 4.3 发布

```powershell
# 1) 改版本
npm version patch --no-git-tag-version

# 2) 打包检查：必须不含 vendor/，体积应在几十 KB
npm pack --dry-run

# 3) 发布
npm publish --access public --registry https://registry.npmjs.org

# 4) 提交、打 tag、推送
git status
git add package.json package-lock.json vendor docs src tests .github/workflows
git commit -m "release: varjson v1.2.0"
git tag v1.2.0
git push origin main
git push origin v1.2.0
```

推送 tag 后，`Release` workflow 会构建、生成 npm tarball 与 VSIX，并创建 GitHub Release。

> 顺序原因：vjson 发布后，消费者安装 `varjson` 时会按 peer 范围去 npm 找 `unireq`。
> 如果先发 vjson，peer 指向的 unireq 版本还不存在，消费者会装不上网络能力。

---

## 5. 日常 GitHub 同步

```powershell
git status
git diff

# 只添加具体文件/目录，不要用 git add -A
git add src/parse.ts tests/parse.test.ts docs/zh/07-api.md

git commit -m "fix: reject invalid numeric literals"
git push origin main
```

约定：

- 提交信息用 `feat:` / `fix:` / `docs:` / `chore:` / `release:` 前缀，一句话说清“为什么”。
- 不提交 `node_modules/`、`dist/`、`dist-test/`、`coverage/`、`*.vsix`、`*.tgz`（已在 `.gitignore`）。
- `vendor/` 必须提交（vjson 的干净 checkout 依赖它）。
- 推送 tag 会触发 Release；普通分支推送只触发 CI。
- 已经存在的 tag 不要强推覆盖；发新版用新 tag。

---

## 6. 回滚与重发

npm 的版本是**不可变**的，同一个版本号不能覆盖重发：

1. **发现内容有问题**：不要改回原版本，直接提升补丁版本（`npm version patch`）重新 `npm publish`。
2. **72 小时内**：可以 `npm unpublish unireq@0.2.0` 撤销单个版本（会同时删除 tarball）。
3. **超过 72 小时**：通常不允许下架；即使能下架也可能破坏依赖者。正确做法是：
   ```powershell
   npm deprecate unireq@0.2.0 "0.2.0 有缺陷，请升级到 0.2.1" --registry https://registry.npmjs.org
   npm version patch --no-git-tag-version
   npm publish --access public --registry https://registry.npmjs.org
   ```
4. **不要**用 `npm unpublish <pkg> --force` 整包删除，除非确认没有任何下游依赖。
5. **Git tag 已推送且 Release 已生成**：不要强推覆盖 tag；改用新 tag（如 `v0.2.1`），旧 Release 保留作为历史。

---

## 7. CI/CD 当前职责（不涉及 npm token）

| 仓库 | 触发 | 行为 |
|---|---|---|
| unireq | push / PR | `npm ci` → typecheck → test → build，矩阵 Node 18.x / 22.x |
| unireq | tag `v*` | 构建 → `npm pack` → 上传 tarball artifact → 创建 GitHub Release |
| vjson | push / PR | `npm ci` → `tsc --noEmit` → test → build；覆盖率 artifact；扩展类型检查（非阻断） |
| vjson | tag `v*` | 构建 → `npm pack` + VSIX → 创建 GitHub Release |

整个流程只使用自动提供的 `GITHUB_TOKEN`（Release 需要 `contents: write`），不需要配置任何 secret。

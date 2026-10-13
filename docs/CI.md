# CI 自动验证

GitHub 是项目的主仓库，完整持续集成由 `.github/workflows/ci.yml` 执行。流水线在分支 push 后运行变更预算检查和完整 `npm run gate`；也支持手动触发。项目采用单人直接推送流程，不要求 PR 或人工审批。Gitee 仓库保留作迁移备份，不再承担 CI。

## 执行与隔离

GitHub Actions 使用 Node.js 22.18 或更新版本，并在全量门禁前将 Docker 数据目录挂载到启用 project quota 的 XFS，以运行真实的工作区配额沙箱测试。完整检查入口 `.ci/run.sh` 会核对 `GITHUB_SHA` 与 checkout 的 HEAD，再安装锁定依赖、安装 Playwright Chromium，并运行 `npm run gate`。本地手动运行时可显式传入目标 commit SHA：

```sh
npm ci
node node_modules/playwright-core/cli.js install --with-deps chromium
GITHUB_SHA="$(git rev-parse HEAD)" .ci/run.sh
```

`gate:static` / `gate:runtime` 可单独运行；它们同样使用隔离环境。门禁复制源代码和依赖到临时目录，保留相对 workspace 链接，避免软链接回实际源码。不复制 `.env`、运行数据库、工作区、缓存、构建产物；只从 `.env.example` 生成空模型凭据、随机主密钥与 loopback 临时端口。迁移、seed、启动和测试均在临时目录执行。默认验收走无真实供应商的可控路径；供应商配额、延迟和模型质量需要另行验证，不能由此门禁证明。不要给 CI 提供真实模型 Key 或生产数据。手动 `verify:*` / `smoke` 命令仍可能操作当前开发实例，自动验收统一使用隔离 gate。

每项检查单独记录退出码、耗时、超时和日志；一个检查失败后继续收集其余结果，最终整体判红。准备数据库或构建失败则停止依赖它的验收，不把未执行项目记成通过。记录写入原仓库 `data/ci/<时间>-<套件>/results.json` 及逐项日志；GitHub Actions 上传 `data/ci/` 收据，保留 7 天，不上传数据库或 `.env`。运行验收超时 10 分钟，完整 workflow 超时 60 分钟。

## 推送与平台边界

本地 `pre-push` hook 使用 Git 推送协议提供的远端旧 SHA，自动运行 `npm run lint:changes -- <远端旧 SHA>` 和 `npm run gate:related -- <远端旧 SHA>`。GitHub Actions 在 push 后运行完整验证，并对照事件中的旧 SHA 检查变更预算。推送后的 CI 是自动反馈，不能撤销已经完成的 push；GitHub 分支保护没有启用，也不要求 PR 或人工审批，符合当前单人直接推送方式。

本地 hook 可由 Git 配置跳过，因此 GitHub Actions 负责留下独立的完整 CI 结果。普通代码变更不调用 LLM 或付费模型 API。发布和部署沿用独立发布流程，不由 CI 自动执行。

## 预算和代码质量

`npm run lint:changes -- <目标分支提交>` 比较目标分支到 HEAD 的已提交改动。本地未提交改动不会进入变更预算；push hook 用本次远端旧 SHA 比较实际推送提交。`.ci/change-policy.json` 初始预算：40 个文件、2000 行新增+删除、单文档 20 KB、函数圈复杂度 25。历史大文档/高复杂度函数允许保持，新增或恶化超过预算判红；文档重复长段落判红。这是维护成本的检查，不判断内容价值或抽象是否必要；这些仍需人工评审。

本地 push hook 从远端旧提交读取预算，提交不能靠放宽本次配置自行通过。预算过大的合法工作应拆分，或单独调整预算并复核验证结果。配置 `CI_ALLOWED_PATHS`（逗号分隔的目录/文件路径）可执行任务范围白名单；该值应由受信任的任务/流水线配置给出，未配置时不擅自限制正常跨模块改动。

TypeScript 启用 `noUnusedLocals`；未使用导入和局部变量直接判红。分层检查解析源码，覆盖普通导入、类型导入、动态 import、require 和相对 re-export，识别 impl 实际路径，不依赖引号风格或 inline 豁免。`verify:ci` 用故意违规夹具证明门禁会失败，验证环境不复制凭据/真实数据、失败后继续运行后续检查且整体返回失败。

修改 `.ci/`、`scripts/`、规则、TypeScript 配置或依赖声明会产生审查提示；删除/改写回归测试额外告警。当前单人流程中这些提示供开发者本人复核，不依赖平台审批。检查清单位于 `.ci/checks.json`；增删检查本身也属于受保护改动。

## Agent-Native 检查图与验证收据

检查清单兼容旧字符串列表；当前节点有 id、script、needs、resources、paths、timeoutMs。循环、缺依赖或缺脚本在执行前失败。静态并发最多 2 项；有 database 资源的检查互斥，runtime 串行。旧行为检查的影响范围尚未精确登记时使用 `*`，保守全选，不以猜测漏跑换速度。

`npm run gate:related -- <base>` 选择关联检查并补依赖闭包，规则、依赖和未知范围保守扩展；它不能替代完整 CI。`npm run gate:docs` 仅跑隔离文档检查，不迁移数据库。`npm run docs:generate` 显式更新目录，`verify:docs` 检查模式不改已维护文件，编译暂存放 `data`。

每次生成 `receipt.json`，包含 HEAD、完整源码文件指纹（含未跟踪文件与软链接目标）、选定检查、可信 base 来源和结果状态。复制前后与结束核对指纹，源码中途变化判红。源/依赖逃逸软链接拒绝，HOME 使用临时目录，浏览器缓存路径单独允许。Loader 的 `.cordis` 缓存、生成构建和 `data` 不进入源码身份；本地 `.env`/`.npmrc` 也不进入。

失败的依赖标 skipped，信号取消标 aborted，超时 failed；未执行不记成功。任务 attach/release 拒绝过期、不完整或失败收据。release 只生成待人工批准状态，不实际发布。

可信目标分支有策略时，删除检查、扩大链接豁免、放宽文档预算、降低工程覆盖基线或扩大重复基线均失败；合法策略调整应单独修改并复核。平台保护状态见 `docs/development/PLATFORM.md`。

新增 quality 仅测两个工程模块的 V8 已执行范围基线，并检查 15 行以上函数的精确标准化重复块；不声称覆盖全产品或检测所有语义重复。历史一个 `readToken` 重复组登记为已有基线，新增同组成员或新重复会失败。

CI 在临时 `action_log` 记录每项检查的真实状态、退出码、耗时与日志 hash；失败不能写成 `ok=1`。持久 JSON 报告保留在原工作树 `data/ci`，临时数据库不复制回来。

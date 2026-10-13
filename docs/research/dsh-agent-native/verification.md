# 实际验证与复现边界

运行日期 2026-10-13，Node v22.19.0，固定 DSH commit `d743267388641bc76f17c45ce8b4c231aed1d32c`。所有副本与辅助依赖均在 `/tmp`，未给模型密钥、未启动付费 API、未改当前项目数据库。精确输出、退出码及本机探针耗时见 [verification.json](evidence/verification.json)。耗时只是单次探针成本，不代表完整 CI 性能。

## 已运行

| 检查 | 正向 | 负向 | 结果 |
| --- | --- | --- | --- |
| 原审批策略三组 Node tests | 80 pass / 0 fail | 测试覆盖按原测试定义，不扩称实际平台保护 | 通过 |
| 原文档预算 | 基线 8 份 standing docs；夹具符合 4 words | 9 words 超预算 | 0 / 1 |
| 原 Markdown 链接 | 文件与 `#good` 锚点存在 | `#missing` 锚点不存在 | 0 / 1 |
| 原类型等价 | 源码与文档 `value: string` | 文档改成 `value: number` | 0 / 1 |
| 原配置来源 | `apiKeyEnv: TEST_KEY` | `apiKey: !!js process.env.TEST_KEY` 绕过来源归属 | 0 / 1 |
| 原历史封存 | 2772 项、6 类，修改后恢复再次通过 | 修改封存笔记；再同时更新其 manifest hash | 0 / 1 / 1 / 0 |

封存负例同时触发 i18n 一致性错误；更新 manifest 后额外观察到“sealed manifest hash changed”，证明对照 Git 基线的约束存在。没有测试所有 possible bypass，不能宣称不可绕过。

原 gate 构造器也实际执行过，读取各 mode 的检查集合及依赖关系，但没有 spawn 这些完整检查。`npm_execpath` 在该读取中仅用于构造参数。构造出的检查集合见 [gate-inventory.json](evidence/gate-inventory.json)，必须与 CI job 调用一起阅读。

## 如何复现

先建立一次性 DSH checkout，固定 SHA；安装辅助依赖时用独立目录及 `--ignore-scripts`，不能给当前项目的依赖或锁文件写入。基线已有 sparse checkout 如需复现全部文件可使用完整 checkout。

```bash
# 以下目录为复现用新目录，不能指向当前业务项目。
git clone https://github.com/deepseek-ai/deepseek-harness /tmp/dsh-research-reproduce
git -C /tmp/dsh-research-reproduce checkout --detach d743267388641bc76f17c45ce8b4c231aed1d32c
npm install --prefix /tmp/dsh-research-reproduce-deps --ignore-scripts --no-audit --no-fund typescript@6.0.3 mdast-util-from-markdown@2.0.3 mdast-util-gfm@3.1.0 micromark-extension-gfm@3.0.0
ln -s /tmp/dsh-research-reproduce-deps/node_modules /tmp/dsh-research-reproduce/node_modules
```

[夹具探针脚本](evidence/probe.py)接收一次性 checkout 与依赖目录。它只复制上游 `scripts/` 到新临时夹具，顺序构造四类正负例；不执行上游 install hooks，也不启动应用。脚本失败时仍清理夹具。

```bash
python3 evidence/probe.py --source /tmp/dsh-research-reproduce --dependencies /tmp/dsh-research-reproduce-deps/node_modules --output /tmp/dsh-reproduced-probes.json
```

上条命令需从本报告目录执行。审批与两个基线命令则从一次性 DSH checkout 执行：

```bash
node --test .github/review-ownership/check-approval.test.mjs .github/review-ownership/blame-ownership.test.mjs .github/review-ownership/author-weight.test.mjs
node --experimental-strip-types scripts/verify-doc-budgets.ts
node --experimental-strip-types scripts/verify-archived-agent-notes.ts
```

封存负向复现：在一次性 checkout 中备份 `.agents/notes/archived/process/2026-06-11-doc-sync-enforcement.md` 和 `.agents/notes/archived/manifest.json`，追加一行后运行原封存脚本；随后更新 manifest 的 `files["process/2026-06-11-doc-sync-enforcement.md"]` 为新内容的 `sha256:` hash，再运行，应分别返回 1；用 `finally` 恢复两文件原始字节，最后应返回 0。本次已执行此流程，输出保留在验证 JSON；该步骤不要在维护中的开发 checkout 运行。

## 未运行及其原因

完整上游 build/CI、所有浏览器回放、真实模型 e2e 和生产迁移都未运行。研究目标是追踪执行机制与验证关键约束，不是在本机认证整个上游发布；完整安装还会扩大依赖和资源范围。真实模型测试需要付费凭据，任务明确禁止。

历史性能、迁移 OOM、ACP 与 GUI 事故来自公开维护者材料，不能混入本机测试统计。公开 PR/保护规则访问缺口见 [开发历史](history.md)。探针初版曾把 type-equiv manifest 写成数组，上游需要 `{entries:[...]}`；夹具已修正，这是研究脚本错误，不是上游缺陷。

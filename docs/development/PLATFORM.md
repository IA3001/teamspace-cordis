# 单人开发的自动验证流程

GitHub 是项目的主仓库，Gitee 保留为历史备份。项目由一个人开发，使用直接推送，不要求 PR、人工逐项批准或外部模型代码审查。GitHub Actions 在 push 后运行完整 CI，作为可见、绑定提交 SHA 的自动反馈。

## 推送前

- 本仓库已安装 Git `pre-push` hook。新 clone 或工作树运行 `npm run hooks:install`。
- 推送时 hook 要求工作树干净、推送为快进更新，并自动运行 `npm run lint:changes -- <远端旧 SHA>` 和 `npm run gate:related -- <远端旧 SHA>`。检查范围按本次实际推送提交计算。
- 完整验证可通过 `npm run gate` 手动执行。推送后的 GitHub Actions 不替代推送前验证，因为失败结果无法撤销已经完成的 push。

本地 hook 只对当前 clone 生效，Git hook 也可被显式跳过，因此 GitHub Actions 负责留下独立的完整 CI 结果。

## 推送后

- `.github/workflows/ci.yml` 在分支 push 和手动触发时运行。变更预算检查对比 push 事件的旧 SHA 与新 SHA；首次推送或手动运行时退回到可用的父提交。
- 完整 CI 使用 Node.js 22.18+，先核对 `GITHUB_SHA` 与 checkout SHA，再安装依赖、安装 Playwright Chromium 并执行 `npm run gate`。
- 结果和 `data/ci` 收据作为 GitHub Actions artifact 保存 7 天，不上传数据库或 `.env`。CI 不调用 LLM 或付费模型 API。

## 边界与记录

推送后 CI 是自动反馈，不是服务器端推送拦截器。当前单人直接推送流程不启用 PR 审批、Code Owner 或要求状态检查才能合并。GitHub 分支保护状态不能从仓库文件推断；若工作方式或账号策略变化，再单独核验平台设置。

Gitee 仓库不再作为主仓库或 CI 平台，不自动同步提交；保留远端 `gitee` 供查阅旧历史。切换日期：2026-10-13。GitHub 私有仓库为 `IA3001/teamspace-cordis`，默认分支和当前开发分支均为 `rebuild-20261009`；旧 `master` 分支保留。

// verify-staging.ts —— 已随暂存指令机制一起注销（2026-10-06）。
//
// 历史：本脚本原为 P2 暂存指令机制的第七门禁（断言 /stage /commit 等语义）。
// IM 化改造（2026-09-30，用户拍板「直达时间线」）后，暂存指令 /stage /commit
// /cur /del /clear 全部注销（staging-commands 保留 /help 与消息路由），
// 本脚本的断言对象已不存在 —— 原文备份在 ../archive/backups/verify-staging.ts.bak-20261006。
//
// 现状：入站消息语义的防回归由 scripts/smoke.sh（8 项，含未登录 401 /
// 发送 / 时间线回读）承担；AI 协作链路由 verify-orchestrator.ts 继续。
console.log('✓ verify:staging 已退役 —— 暂存指令随 IM 化注销，防回归由 smoke.sh 承担')

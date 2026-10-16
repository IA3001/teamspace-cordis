# Agent 多文件工程完整性检查

本变更新增 `tool.workspace.verify`，供编码者和测试者检查项目交付清单、CMake `add_executable` 源文件以及源文件中的本地引号 include。Agent 在本轮写入 CMake 工程后，运行时要求先通过该检查才能结束；用户任务中明确列出的文件会自动加入检查清单。

升级执行 migration 0037，为内置编码者和测试者追加该工具，同时保留团队已有工具配置。回滚 migration 不改动 Agent 配置；若回滚代码，旧版本会忽略未注册的工具 ID。

该检查确认文件存在，不运行 C++ 编译器，也不验证运行时输出。执行实际构建或运行仍需单独的受控编译工具。

验证：`scripts/verify-project-completeness.ts`、`scripts/verify-sandbox-tools.ts`、`scripts/verify-agent-bootstrap.ts`。

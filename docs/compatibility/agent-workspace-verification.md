# Agent 多文件工程完整性检查

本变更新增 `tool.workspace.verify`，供编码者和测试者检查项目交付清单、CMake `add_executable` 源文件以及源文件中的本地引号 include。Agent 在本轮写入 CMake 工程后，运行时要求先通过该检查才能结束；用户任务中明确列出的文件会自动加入检查清单。

本次继续新增 `tool.workspace.run-cpp`，供任务明确要求真实编译、运行或原始 stdout 时调用。它只接受个人工作区的项目目录与可选 `add_executable` 目标名，从 `CMakeLists.txt` 读取显式 C/C++ 源文件，在固定 digest 的 GCC 14 容器中使用固定编译选项构建并运行目标。容器无网络、非 root、项目文件与共享区只读，写入仅限有时限和容量上限的临时目录；总执行时间上限 45 秒。工具会分别报告编译失败、源文件缺失、程序退出码、超时、原始 stdout 和 stderr。执行图要求编译运行类任务拿到成功的真实运行结果才能完成；源文件后续有修改时需要重新验证。

运行服务前需在 Docker 主机预拉取固定镜像：`docker pull gcc:14-bookworm@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15`。工具调用期间容器本身不联网。

编译器直接编译目标中列出的源文件，不执行任意 CMake 配置脚本，因此适用于简单 `add_executable(target source.cpp ...)` 工程；复杂 generator expression、`target_sources`、CMake toolchain、自定义构建步骤与第三方包配置不受支持。全功能 CMake 工程需要后续专用构建镜像和更完整的受控配置执行能力。

升级执行 migration 0037 和 0038，为内置编码者和测试者追加完整性检查与受控 C++ runner，同时保留团队已有工具配置。回滚 migration 不改动 Agent 配置；若回滚代码，旧版本会忽略未注册的工具 ID。

验证：`scripts/verify-project-completeness.ts`、`scripts/verify-sandbox-tools.ts`、`scripts/verify-agent-bootstrap.ts`。

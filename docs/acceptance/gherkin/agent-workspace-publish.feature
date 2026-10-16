# language: zh-CN
功能: Agent 之间受控共享多文件工程
  Agent 在自己的工作区创建工程后，可显式将完整工程发布到团队共享工作区；
  队友只能通过共享范围读取发布结果，不能访问发布者的个人区。

  场景: 编码 Agent 原子发布多文件工程供队友读取
    假如 Agent A 的个人工作区包含 `projects/hello-cordis/src/main.cpp` 和 `projects/hello-cordis/README.md`
    并且 Agent A 的配置允许调用 `tool.workspace.publish`
    当 Agent A 将 `projects/hello-cordis` 发布到团队共享工作区
    那么团队共享工作区出现包含两个原文件的完整工程目录
    并且发布结果记录源 Agent、会话、源路径、目标路径、文件数和总字节数
    并且 Agent B 使用 `tool.workspace.read` 的 `shared` 范围读取 `projects/hello-cordis/src/main.cpp` 得到原始内容
    并且 Agent B 仍不能从自己的个人工作区读取 Agent A 的私有源文件

  场景: 工程发布拒绝越界、符号链接、超限文件和已有目标
    假如 Agent A 使用工程发布工具
    当源目录不在个人 `projects/` 下、包含符号链接或特殊文件、超过文件数或总大小限制，或共享目标已存在
    那么系统拒绝发布并返回明确原因
    并且已存在的共享工程保持原样
    并且失败的发布不会留下部分可读取的目标目录

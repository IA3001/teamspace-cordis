---
name: space-verify
description: 选择相关隔离检查并形成版本绑定的验证收据。
---

# space-verify

运行 gate:related 或 gate:docs 收集反馈，交付运行完整 gate。查看 receipt.json 的指纹、失败、跳过与中止；代码变化后重验。不向 CI 提供真实模型 Key，不用直接 smoke 接触生产实例。

具体命令与格式见 [开发流程](../../../docs/development/WORKFLOW.md)。

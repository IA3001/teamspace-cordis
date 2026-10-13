# 消费者验证审计

## 保留与补足

- 原 verify:user-errors 的函数输出断言属于行为检查，保留；禁止暴露原始异常的源码扫描属于结构约束，不冒充浏览器验收。
- 移除暂停组件特定表达式源码匹配，新增真实浏览器通过WebSocket RPC夹具显示未知暂停原因的断言，证明内部reason不直接上屏。
- 原 release-start 在只读产物 checkout 中走 npm start 与浏览器，继续保留；新增Loader/Include服务注入与资源清理测试。
- 浏览器导航新增原origin与已检查manifest对应chunk内容hash断言。现有页面内容、操作及pageerror/console断言继续生效。
- 实际安装Include以patch指令更新；本项目compose以有序层整项替换，非同一种输入方言。消费者回归验证config替换、disabled与表达式往返，不宣称两者原始清单可直接交换。

## 升级与恢复

verify:upgrade-fixtures使用真实v31 SQL构造旧库，再执行后续真实迁移至当前版本，验证正文保留、旧向量不冒充已知模型，以及事务中断回滚。verify:backup-restore验证备份恢复，verify:embedding-index保护模型身份与重试。它们不证明全部可能的历史数据库均能升级；格式变化须新增对应夹具和兼容登记。

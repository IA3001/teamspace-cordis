# 真实 Loader 验收测试的接口误用

状态：archived；日期：2026-10-13。

问题：新增工程消费者测试错误调用根 Context.dispose，安装版本没有该方法。finally中的异常一度覆盖测试主体结果；错误不属于产品运行逻辑。

决定：保留真实Loader路径，保存ctx.plugin返回的Fiber并销毁该Fiber，确认子插件effect计数从1归零。finally再次销毁仍保持幂等。没有修改产品内Agent。

验证：verify:engineering-consumers沿实际Loader/Include加载提供者与消费者、替换config并验证注入结果与清理；故意错误的值或缺失effect清理会使断言失败。该测试曾实际失败，修正后通过。

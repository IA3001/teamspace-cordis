# config

- [packages/client-ui/space-client-ui-teamspace/src/index.ts](../../packages/client-ui/space-client-ui-teamspace/src/index.ts)：`TeamspaceApiConfig`

```ts
interface TeamspaceApiConfig {
  publicBaseUrl: string | null
  port: number
}
```

- [packages/impl/space-store-sqlite/src/index.ts](../../packages/impl/space-store-sqlite/src/index.ts)：`Config`

```ts
interface Config {
  /** 缺省与 debug-database-sqlite 同文件（cordis.yml 里显式写同一处路径）。 */
  path?: string
}
```

- [packages/impl/space-workdir-local/src/index.ts](../../packages/impl/space-workdir-local/src/index.ts)：`Config`

```ts
interface Config {
  /** 数据目录（工作区落在 <dataDir>/workdirs/<agentId>）。缺省 <cwd>/data，与 store 同源。 */
  dataDir?: string
}
```

- [plugins/app/index.ts](../../plugins/app/index.ts)：`Config`

```ts
/** 配置由 cordis.yml 中该项的 config 字段传入。*/
interface Config {
  greeting: string
}
```

- [plugins/brain-llm/index.ts](../../plugins/brain-llm/index.ts)：`Config`

```ts
interface Config {
  /** 真大脑开关（false = 不注册，回 coordinator_unconfigured 安全默认）。 */
  enabled?: boolean
}
```

- [plugins/brain-stub/index.ts](../../plugins/brain-stub/index.ts)：`Config`

```ts
/** 运行时取值形状（兼容旧取值：可选，缺省启用）。*/
interface Config {
  /** 占位大脑开关（false = 不注册大脑，回到 coordinator_unconfigured 安全默认）。 */
  enabled?: boolean
}
```

- [plugins/flow-commands/index.ts](../../plugins/flow-commands/index.ts)：`Config`

```ts
/** 运行时取值形状（兼容旧取值：flows 可选）。*/
interface Config {
  /** 指令 → 步骤链（agent 名册 title 或 id）。缺省三条 MC 式服务流程。 */
  flows?: Record<string, string[]>
}
```

- [plugins/orchestrator/index.ts](../../plugins/orchestrator/index.ts)：`Config`

```ts
/** 运行时取值形状（兼容旧取值：全部可选，缺省回 DEFAULT_BUDGET）。*/
interface Config {
  /** 每回合自治预算（引擎发起委托/继续调用的次数上限）。缺省 8。 */
  autonomyBudget?: number
}
```

- [plugins/space-auth/index.ts](../../plugins/space-auth/index.ts)：`Config`

```ts
/** 面板可配（5172 → 插件 → space-auth）：Team 注册开关。*/
interface Config { registerEnabled?: boolean }
```

- [plugins/space-tool/index.ts](../../plugins/space-tool/index.ts)：`Config`

```ts
/** 运行时取值形状（兼容旧取值：allow 可选，undefined = 全放行）。*/
interface Config {
  /**
   * 调用白名单：配置了就只允许清单内的 toolId 被调用（其余 not_allowed）；
   * 缺省全放行。空数组 = 全部拒绝（显式收紧的合法取值）。
   */
  allow?: string[]
}
```

- [plugins/space-upload/index.ts](../../plugins/space-upload/index.ts)：`Config`

```ts
/** 面板可配（5172 → 插件 → space-upload）：存储目录与大小上限。*/
interface Config { dir?: string; maxMb?: number }
```

- [plugins/staging-commands/index.ts](../../plugins/staging-commands/index.ts)：`Config`

```ts
interface Config {}
```

- [src/config.ts](../../src/config.ts)：`AppConfig`

```ts
interface AppConfig {
  app: {
    name: string
    description?: string
  }
  loader: {
    /** 插件组合清单的路径（相对项目根） */
    configPath: string
  }
}
```

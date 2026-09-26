// 应用级配置加载：读取 config/app.yml 并校验。
//
// 这里是**系统边界**（外部输入是磁盘上的文件），所以做显式校验；
// 插件内部拿到的配置已由 loader 依据插件声明的 Schema 校验过，不重复校验。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'

export interface AppConfig {
  app: {
    name: string
    description?: string
  }
  loader: {
    /** 插件组合清单的路径（相对项目根） */
    configPath: string
  }
}

/** 配置文件相对项目根的位置。 */
export const CONFIG_FILE = 'config/app.yml'

export function loadAppConfig(): AppConfig {
  const file = resolve(process.cwd(), CONFIG_FILE)

  let raw: unknown
  try {
    raw = parseYaml(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`读取配置文件失败：${file}\n${(err as Error).message}`)
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`配置文件顶层必须是一个对象：${file}`)
  }

  const data = raw as Record<string, any>
  const name = data.app?.name
  if (typeof name !== 'string' || name === '') {
    throw new Error(`配置文件缺少 app.name：${file}`)
  }

  const configPath = data.loader?.configPath
  if (typeof configPath !== 'string' || configPath === '') {
    throw new Error(`配置文件缺少 loader.configPath：${file}`)
  }

  return {
    app: {
      name,
      description: typeof data.app?.description === 'string' ? data.app.description : undefined,
    },
    loader: { configPath },
  }
}
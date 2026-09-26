# teamspace-cordis

> 多人 + 多 Agent 团队协作系统 —— 基于 cordis 元框架，一切皆插件。

这份说明写给**完全没接触过这个项目的人**。不需要你懂 cordis，也不需要你懂 TypeScript，
照着「三步跑起来」做，就能看到它在你电脑上正常启动。

---

## 一、这是个什么东西

先用大白话讲清楚三个词。

**cordis** 是一个「元框架」。普通框架是给你一堆功能让你用；元框架是给你一套
「插件怎么插上去、怎么拔下来」的机制，功能全靠插件往里加。好处是：想删掉一个功能，
就在清单里删一行；想加一个功能，就加一个文件。不需要去改框架本身的代码。

**插件（plugin）** 就是一个独立的小功能模块。比如「提供网页服务」是一个插件，
「健康检查接口」是一个插件，以后「日志系统」「用户管理」也各是一个插件。

**本项目** 现在**还是一个空壳**：框架跑得通，但里面只有两个用来演示的小插件。
它的价值不在于现在能干什么，而在于**骨架是对的**——后面所有功能都往这个骨架上挂。

所以现在跑起来，看到的就是几行启动日志 + 一个健康检查网址，**这是正常的、也是预期的**。

---

## 二、三步跑起来

### 第 0 步：确认环境（只需做一次）

打开终端（WSL / Linux 里），确认 Node.js 版本：

```bash
node -v
```

需要 **v20.6 或更高**（本项目实测用 v20.17.0）。
为什么要 20.6？因为启动脚本用了 Node 自带的 `--env-file` 功能来读取配置文件，
这个功能是 20.6 版本才有的。低于这个版本会在启动时报一行 `bad option: --env-file`。

> 如果提示 `node: command not found`，说明 Node 不在系统路径里。
> 本项目默认去 `/home/ia3000/SPM/.toolchain/node/bin` 找 Node，
> 想换地方就设环境变量 `NODE_BIN_DIR`。

### 第 1 步：装依赖（只需做一次）

```bash
cd /home/ia3000/SPM/teamspace-cordis
npm install
```

这一步是把 cordis 等第三方包下载到 `node_modules/` 目录里。以后没改过
`package.json` 就不用重复做。

### 第 2 步：启动

```bash
npm start
```

或者直接跑脚本（效果一样）：

```bash
./scripts/run.sh
```

你会看到类似这样的输出，**出现下面这些就说明成功了**：

```
  teamspace-cordis 启动中 …

  后端监听   http://0.0.0.0:8080   （健康检查 /healthz）
  控制台 dev 端口 5173（Vite，暂未启用）
  团队空间 dev 端口 5174（Vite，暂未启用）
  环境       development

[teamspace-cordis] 启动中（NODE_ENV=development）
[teamspace-cordis] 监听口径 0.0.0.0:8080（来自 .env）
[teamspace-cordis] 框架启动完成（插件清单：./cordis.yml）
[plugin:app] cordis 框架已启动，一切就绪
```

最后那行 `[plugin:app]` 是插件自己打的日志，说明插件被成功加载并执行了。

### 第 3 步：验证它真的在干活

**另开一个终端**（原来的窗口要一直开着，它就是正在运行的服务），执行：

```bash
curl http://127.0.0.1:8080/healthz
```

会返回一段 JSON：

```json
{"ok":true,"service":"teamspace-cordis","listening":"0.0.0.0:8080","pid":1234,"uptime":5,"time":"..."}
```

看到 `"ok":true` 就说明服务活着。

**重点看 `listening` 这一项**：它显示的是服务「实际绑定」的地址端口。
把它和你配置文件 `.env` 里写的 `APP_PORT` 对一下——**必须一模一样**。
这就是我们验证「端口前后一致」的方式：不是靠人肉核对配置，而是让程序自己报出实际值。

也可以直接用浏览器打开 <http://localhost:8080/healthz>（WSL2 下这能通，见第九节）。

### 停止

回到运行服务的那个终端，按 `Ctrl-C`。

如果窗口已经关了、或者进程卡住了，用这个脚本按端口兜底清掉：

```bash
npm run stop
```

只想看看谁占着端口、不想杀进程：

```bash
./scripts/stop.sh --check
```

---

## 三、开发时怎么跑

日常写代码用**开发模式**：

```bash
npm run dev
```

它和 `npm start` 的唯一区别是加了「自动重启」：你改了 `src/` 或 `plugins/` 里的
代码，一保存，服务自己就重启了，不用手动停再起。

改完代码想检查有没有类型错误：

```bash
npm run typecheck
```

---

## 四、文档里出现的四个端口

| 端口 | 用途 | 现在启用了吗 |
|---|---|---|
| **8080** | 后端服务（HTTP 接口、健康检查） | ✅ 已启用 |
| **5173** | 控制台前端（网页界面） | ⬜ 还没做 |
| **5174** | 团队空间前端（网页界面） | ⬜ 还没做 |

后两个是给之后的前端页面预留的，现在跑起来没有东西，属于正常。

---

## 五、项目里每个文件是干嘛的

```
teamspace-cordis/
├── .env.example          ← 【必读】环境变量模板，定义端口等参数
├── .env                  ← 你的实际配置（由上面那个自动复制生成，不入库）
├── cordis.yml            ← 【必读】插件清单：有哪些插件、各自什么配置
├── config/
│   └── app.yml           ← 应用名等基础参数（不含端口）
├── src/
│   ├── index.ts          ← 程序入口：启动框架，一共 30 行，零业务
│   └── config.ts         ← 读取并校验 config/app.yml
├── plugins/
│   ├── app/index.ts      ← 演示插件（打印一行日志）
│   └── health/index.ts   ← 健康检查插件（/healthz 接口）
├── scripts/              ← 【必读】所有运行脚本都在这
│   ├── env.sh            ← 公共前置：读 .env + 校验 + 指定 Node 位置
│   ├── run.sh            ← 正式启动
│   ├── dev.sh            ← 开发模式（改代码自动重启）
│   └── stop.sh           ← 按端口停止
├── package.json          ← 依赖列表 + 命令别名（npm start 等）
├── tsconfig.json         ← TypeScript 配置
└── node_modules/         ← 第三方包（npm install 生成，不用管）
```

> `.cordis/` 目录是框架运行时自动生成的，不用手动碰，也不要提交。

---

## 六、两条必须记住的规矩

这两条是本项目刻意定下的**标准**，破坏它们会带来麻烦。请务必遵守。

### 规矩一：端口只在 `.env` 里写一次

`.env` 是全系统端口的**唯一出处**。代码、插件清单、脚本，全部从它取值，谁也不许自带
默认数字。

```bash
APP_HOST=0.0.0.0        # 监听地址：0.0.0.0 = 所有网卡，WSL2 下必须用它
APP_PORT=8080           # 后端端口
CONSOLE_PORT=5173       # 控制台前端端口
TEAMSPACE_PORT=5174     # 团队空间前端端口
NODE_ENV=development
LOG_LEVEL=info
TZ=Asia/Shanghai
```

为什么这么较真？因为端口一旦散落在多个文件里，迟早会对不齐——改了这边忘了那边，
然后花半天找一个「怎么连不上」的毛病。现在只有一处，改一次全局生效。

`cordis.yml` 里是这么读它的（不用你手动改，知道有这么回事即可）：

```yaml
- id: server
  name: '@cordisjs/plugin-server'
  config:
    host: !!js process.env.APP_HOST ?? '0.0.0.0'
    port: !!js Number(process.env.APP_PORT ?? 8080)
```

`!!js` 是插件清单支持的一种写法，意思是「这行值要执行一小段代码算出来」，
所以它能从 `.env` 里读到端口。

**配套的安全网**：`scripts/env.sh` 会检查这 4 个端口变量在不在。少一个就**直接报错退出**，
不肯带你用默认值悄悄跑起来。宁可当场报错，也不要跑出一个配置不对的系统。

### 规矩二：加功能 = 加一个插件文件 + 在清单里加一行

不要往 `src/index.ts` 里塞业务代码。那个文件只负责「把框架点着」。

---

## 七、手把手：加一个你自己的插件

假设你要加一个接口 `/hello`，返回一句问候。整个过程**两步**。

### 第 1 步：新建文件 `plugins/hello/index.ts`

```ts
import type { Context } from 'cordis'

export const name = 'hello'

// 声明「我需要 server 服务」。框架会等到 server 就绪才加载本插件，
// 加载顺序不用你自己操心。
export const inject = ['server']

export function apply(ctx: Context) {
  ctx.server.get('/hello', async () => {
    return Response.json({ message: '你好，我是新插件' })
  })
}
```

### 第 2 步：在 `cordis.yml` 末尾加一项

```yaml
- id: hello
  name: './plugins/hello/index.ts'
```

### 完成

保存。如果你用的是 `npm run dev`，服务会自动重启，然后访问：

```bash
curl http://127.0.0.1:8080/hello
```

想**删掉**这个功能，就把 `cordis.yml` 里那两行去掉，文件留着不碍事。
这就是「一切皆插件」的意思：功能的开关在清单里，不在代码里。

---

## 八、改配置的注意事项

- **改端口 / 监听地址** → 改 `.env`，然后重启。别去改 `cordis.yml` 里的数字。
- **改应用名** → 改 `config/app.yml`。
- **`cordis.yml` 的顶层必须是一个数组**（每项以 `- ` 开头）。写成对象会直接报错，
  这是 cordis 的硬性格式要求。
- **刚拿到项目时 `.env` 不存在**：不要紧，`scripts/env.sh` 会自动从 `.env.example`
  复制一份。你也可以手动 `cp .env.example .env`。
- 想临时停用某个插件，不用删行，在它下面加一行 `disabled: true` 即可。

---

## 九、常见问题

**Q：`node: command not found`**
Node 不在系统路径里。设 `NODE_BIN_DIR` 指向 Node 所在目录，或确认
`/home/ia3000/SPM/.toolchain/node/bin/node` 是否存在。

**Q：启动时报 `bad option: --env-file`**
Node 版本太低，需要 20.6 以上。升级 Node。

**Q：报错说 `.env` 缺少必需变量**
`.env` 里少了 `APP_HOST` / `APP_PORT` / `CONSOLE_PORT` / `TEAMSPACE_PORT` 中的某一个。
打开 `.env` 对照 `.env.example` 补齐即可。

**Q：`EADDRINUSE`（端口被占用）**
8080 被别的进程占了。先 `./scripts/stop.sh --check` 看看是谁，
再 `./scripts/stop.sh` 清掉；或者改 `.env` 里的 `APP_PORT` 换个端口。

**Q：浏览器打不开 `localhost:8080`**
本项目已把监听地址设为 `0.0.0.0`（不是 `127.0.0.1`），就是为了让 WSL2 里的服务
能被 Windows 侧的浏览器访问。请确认 `.env` 里 `APP_HOST=0.0.0.0`。
另外 WSL2 有一个已知现象：重启 WSL 后 Windows 侧的 `localhost` 转发偶尔会失效，
此时执行 `wsl --shutdown` 后重开即可。

**Q：`stop.sh` 提示需要 lsof**
装一下：`sudo apt install lsof`。

**Q：启动日志里怎么没有 `[plugin:health]` 的输出？**
健康检查插件本来就不打印日志，它只注册了一个接口，用 `curl` 才能看到它的存在。

---

## 十、给下一个接手的人的备注

- 目前**没有提交 git**，也没有配置 CI。
- 日志系统还**没有实现**。目前启动信息走的是 `console.log`。
  原因记录在 `cordis.yml` 末尾的注释里：官方的 `@cordisjs/plugin-logger` 和
  `cordis@4.0.0-rc.10` 这个组合搭配时，`ctx.logger` 的输出会被静默丢弃
  （实测过 3 次）。core 自带的导出器接口本身可用，将来要写日志插件时从这里入手。
- 现在用的 cordis 是 **v4 的 RC（候选发布）版本**，还不是正式版，遇到怪问题时
  记得先怀疑版本本身。

---

## 附：常用命令速查

| 命令 | 作用 |
|---|---|
| `npm install` | 安装依赖（首次） |
| `npm start` | 启动（等价 `./scripts/run.sh`） |
| `npm run dev` | 开发模式，改代码自动重启 |
| `npm run stop` | 按端口停掉服务 |
| `npm run typecheck` | 检查 TypeScript 类型错误 |
| `./scripts/stop.sh --check` | 只看端口占用，不杀进程 |
| `curl http://127.0.0.1:8080/healthz` | 验证服务是否存活 |
# 主应用生产部署流程

本项目以单实例 Node.js 服务运行，SQLite 数据库保存在 `data/database.db`。正式发布使用 `teamspace-cordis/` 仓库，不部署已弃用的 `teamspace/`。

## 首次部署

1. 在 Linux 主机创建专用运行账号和发布目录，安装 Node.js 22.5.0 或更新版本，以及 Docker Engine（Agent 代码执行依赖 Docker 隔离容器）。npm 会根据 `package.json` / `.npmrc` 强制检查 Node 版本。优先使用 rootless Docker；标准 Docker socket 的访问权限相当于主机管理员权限。由运行账号检出经过验证的提交或版本标签；systemd 会在运行期间限制代码目录写入。
2. 由运行账号执行 `npm ci` 安装锁定依赖。复制 `.env.example` 为 `.env`，设置 `NODE_ENV=production`、监听地址和端口及日志时区。生成 `SETTINGS_ENCRYPTION_KEY`（`openssl rand -base64 32`）并保存在部署密钥管理处；它用于加密数据库中的模型和搜索 API 密钥，必须与数据库备份分开备份，丢失后需重新录入 API 凭据。确保默认 `PATH` 中的 Node.js 至少为 22.5；只有需要固定某个 Node 安装时才设置 `NODE_BIN_DIR`（例如 `/usr/bin`）。不要把 `.env` 提交到 Git。
3. 首次启动前运行 `npm run migrate` 创建或升级 SQLite schema，并执行 `npm run prepare:release` 构建 UI、生成组合清单和校验发布产物。后续版本升级前先运行 `npm run backup`；服务停止后执行 `npm ci`、`npm run prepare:release` 和 `npm run migrate`。
4. 执行 `npm run gate:static`。在隔离、合成数据的预发副本先用 `NODE_ENV=development` 启动候选版本，再执行 `npm run gate:runtime`；该门禁包含后台/Teamspace 可达性、Playwright UI 回归、写入型 `smoke`、运行时验证，以及 `verify:release-start` 的只读代码树生产启动检查。发布启动检查会在临时副本执行迁移和 release build，锁定完整 checkout（含 `node_modules`）与 UI 产物，只允许数据目录和组合清单写入，再确认 API、Teamspace、调试页均可访问且源码哈希不变。预发主机需安装可运行的 Chromium；非标准路径通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定。Runtime gate 只在自动创建的副本中使用合成数据和空模型凭据；直接执行单项 verify/smoke 可能操作当前开发实例，禁止拿生产实例验收。随后使用独立 `.env`、数据库和密钥，以 `NODE_ENV=production` 准备并启动隔离副本；确认 `npm run check:release-artifacts` 通过、`composed.cordis.yml` 存在且可写，再核对 `/healthz`、后台页面可直接访问、Team 注册/登录及 Team token 认证。生产模式不要运行 `smoke` 或完整 `gate:runtime`，smoke 会主动拒绝生产环境。确认检查通过后再将版本切为当前发布。
5. 以专用账号运行 `npm start`。systemd 部署可使用仓库模板 `deploy/teamspace-cordis.service`：模板固定以 `teamspace` 用户运行 `/srv/teamspace-cordis` 下的 checkout，失败后自动重启，stdout/stderr 进入 journald。运行账号拥有 checkout 和数据目录；systemd 运行期间将 checkout 设为只读，仅对 `composed.cordis.yml` 和 `data/` 开放必要写入；`.env` 仅由运维人员在服务停止时更新。启动锁文件位于 `data/`，同一运行账号从 systemd 与外部手动启动时仍共享锁，不受 `PrivateTmp=true` 影响；运行账号需能写入数据目录。生产 UI 产物在发布准备阶段构建并于启动时校验，不重建源码；组合清单仍在项目根生成，以保持 Cordis 按清单目录解析插件的语义。模板默认授予系统 Docker daemon 的 `docker` 组访问权；改用 rootless Docker 时移除此行并配置该账号的 rootless socket。按实际 Node/npm 安装位置调整 `PATH` 或 `/usr/bin/env`。不要以 root 运行应用。

```sh
sudo install -o root -g root -m 0644 deploy/teamspace-cordis.service /etc/systemd/system/teamspace-cordis.service
sudo systemctl daemon-reload
sudo systemctl enable --now teamspace-cordis
sudo systemctl status teamspace-cordis
journalctl -u teamspace-cordis -n 100 --no-pager
```

若 Node.js/npm 不在 systemd 默认 `PATH` 中，为服务添加 drop-in；将示例路径替换为实际同时包含 `node` 和 `npm` 的目录：

```sh
sudo systemctl edit teamspace-cordis
```

在编辑器中写入：

```ini
[Service]
Environment="PATH=/opt/node-v22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"
```

保存后执行 `sudo systemctl daemon-reload`，再启动服务并检查 `journalctl -u teamspace-cordis`。如果 `.env` 设置了 `NODE_BIN_DIR`，也应确保对应目录可执行且与该 `PATH` 中的 npm 版本配套。

unit 模板通过 `RequiresMountsFor=` 等待工作区卷，并以 `ConditionPathIsMountPoint=` 拒绝在路径退化为普通目录时启动应用，避免把工作区写到系统盘。配额助手需要通过 sudo 更新 XFS project 映射，因此不要在 unit 中启用 `NoNewPrivileges=true` 或只读 `/etc` 沙箱，除非同时为助手设计并验收了相应的 systemd 文件权限例外。更新时用 `systemctl stop/start teamspace-cordis`；发布路径固定时无需改 unit。

`ReadOnlyPaths=` 限制运行时对 checkout 的直接写入，组合清单是明确的单文件例外；它不构成完整进程沙箱。不要在 checkout 的代码目录下添加额外挂载；systemd 的路径限制不会约束传播进服务命名空间的子挂载，也不能阻止有足够权限的进程撤销挂载限制。[systemd.exec 文件系统路径限制](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)。使用系统 Docker socket 时，`docker` 组权限等同主机管理员权限；rootless Docker 可缩小这项权限。

## 预发验收与恢复演练

预发必须使用独立 checkout 根目录和独立 `.env`；应用数据目录相对当前工作目录位于 `data/`，因此不要让预发和生产共用 `data/`、端口或密钥。使用合成/脱敏数据启动预发服务，先运行 `npm run gate:static`，再在开发模式运行 `npm run gate:runtime`。另在生产模式检查启动、后台管理入口可达与管理网隔离、Team 用户认证及身份域隔离；仅使用隔离预发数据库执行会写数据的检查。确认登录、Agent 记忆追赶、`@AI` 回复、工具调用和文件访问都通过后，才允许生产发布。

恢复演练从预发快照开始：执行 `npm run backup -- --include-workdirs`，将快照复制到独立演练目录，恢复数据库、日志、上传、共享交付和工作区，使用对应 `SETTINGS_ENCRYPTION_KEY` 启动候选版本；核对 `/healthz`、`PRAGMA integrity_check`、成员会话访问、附件读取与加密 API 配置可解密。记录恢复用时、缺失数据和操作步骤。不得把生产快照直接恢复到开放的预发环境，也不得在生产库运行 smoke。

## 更新与回滚

更新按维护窗口执行：先在运行中的旧版本执行 `npm run backup`，确认快照完成；再停止 systemd 服务，检出候选版本并运行 `npm ci`、`npm run prepare:release` 和 `npm run migrate`，最后启动新版本。`prepare:release` 会构建 UI、重新组合 manifest 并验证所有静态产物。示例：

```sh
npm run backup
sudo systemctl stop teamspace-cordis
git checkout <release-tag>
npm ci
npm run prepare:release
npm run migrate
sudo systemctl start teamspace-cordis
```

不要让旧进程与迁移后的 schema 并行运行。启动后验证 `/healthz`、后台管理页面可直接打开及 Teamspace 登录；写入型 smoke 只在隔离预发执行。若迁移或启动失败，停止服务并按下方流程恢复整套数据快照，再启动旧版本。生产启动会检查活动 UI 页面所需构建产物与组合清单可写权限，构建应在发布阶段完成；开发环境的 `npm start` 仍会启动前构建。

回滚代码前确认新迁移是否向后兼容。若旧版本不能读取新 schema，停止服务后从同一备份快照恢复 `database.db`、存在时的 `logs.db`、`uploads/` 和 `shared-workspace/`；若该快照包含 `workdirs/`，也一并恢复，再启动旧版本。恢复加密配置还需要对应的 `SETTINGS_ENCRYPTION_KEY`。不要在生产数据上直接运行 `npm run reset` 或未经演练的 `npm run migrate:down`。

## 运行与数据边界

- 端口只在 `.env` 配置。生产实例分别监听 `APP_PORT`（API）、`TEAMSPACE_PORT`（Teamspace 页面）和 `DEBUG_PORT`（后台与调试控制台）。若反向代理只向浏览器提供一个标准 HTTPS origin，在 `.env` 设置 `TEAMSPACE_API_BASE_URL=https://team.example.com`；代理将 `/api/*` 转发给 `APP_PORT`，其余 Teamspace 页面和 WebSocket 流量转发给 `TEAMSPACE_PORT`。该配置只接受不含路径、查询或片段的 HTTP(S) origin，生产环境强制 HTTPS。未设置时，浏览器按同一主机名直连 `APP_PORT`。`DEBUG_PORT` 同时承载后台与无登录的插件、日志和数据库查看页，必须限制在管理网/VPN；不要直接暴露公网。可将应用监听地址设为 `127.0.0.1`，由反向代理访问本机上游。
- 后台管理员凭据由生产环境变量初始化，后台 session 与 Team 用户 token 分开保存。文字模型、Embedding 和网页搜索配置分别在后台维护；文字模型与 Embedding 可使用 `.env` 变量作为部署兜底，网页搜索目前由后台设置管理。
- 持久数据位于 `data/`；应用日志由调试日志插件写入 `data/logs.db`，服务进程 stdout/stderr 由 journald 或同类服务管理器收集。`npm run backup` 使用 SQLite 在线一致性快照备份 `data/database.db` 与 `data/logs.db`，并复制 `data/uploads/` 和后台批准交付的 `data/shared-workspace/`。Agent 私有工作区可能较大，评估容量后用 `npm run backup -- --include-workdirs` 纳入备份；若不纳入，故障恢复会丢失其中尚未提交到共享区的文件。备份目录权限仅向运行账号开放。不要备份 `node_modules/` 或 `dist/`。加密密钥需独立保管并纳入灾难恢复演练。
- 沙箱代码容器限制为 512 MiB 内存、0.75 CPU、64 个进程、45 秒运行时、256 MiB 容器可写层和单文件 64 MiB；个人工作区可读写、团队共享区只读，容器网络可用。工作区是持久 bind mount，不受容器可写层配额约束；团队应对 `data/workdirs/` 所在磁盘配置主机级容量告警和限制。
- 发布前确认 `.env` 权限仅限运行账号和运维人员读取，备份同样按敏感数据保护。

## Agent 工作区磁盘配额（Linux/XFS 运维步骤）

容器 `--storage-opt size=256m` 不限制挂载到 `/workspace` 的宿主机目录。生产环境可将 `data/workdirs/` 放到启用了 XFS project quota 的专用挂载点，并给每个 Agent 工作区分配独立 project ID。XFS 项目配额限制目录树的块用量，超限写入由文件系统拒绝；官方 `xfs_quota(8)` 文档说明，初始化 project tree 后，新建文件会继承项目归属。[XFS 项目配额说明](https://man7.org/linux/man-pages/man8/xfs_quota.8.html)

先在 `/etc/fstab` 为专用 XFS 挂载配置 `prjquota`（部分发行版使用 `pquota`），然后通过 `findmnt -T /srv/teamspace-cordis/data/workdirs` 确认文件系统类型和生效挂载选项。`data/workdirs/` 必须是独立挂载点，不能只位于包含数据库、日志、上传和共享交付的 `data/` 文件系统中。若发布目录采用版本化路径或软链接，需将工作区挂载配置在稳定数据路径，并通过 `space-workdir-local` 的 `dataDir` 指向该持久数据目录。project ID 和名称映射由下方助手统一维护；不要手工为同一目录追加另一套 `/etc/projects`、`/etc/projid` 记录，否则助手会按冲突失败关闭。

使用存储系统提供的卷 UUID（不要格式化或覆盖含数据的卷），将下面示例中的 UUID 替换为实际值，并把挂载点设为稳定的数据路径：

```fstab
UUID=<workdir-volume-uuid> /srv/teamspace-cordis/data/workdirs xfs defaults,prjquota 0 0
```

首次挂载后明确核对文件系统类型、挂载选项和项目配额状态；任一项不符时不要启动生产应用：

```sh
sudo mkdir -p /srv/teamspace-cordis/data/workdirs
sudo mount /srv/teamspace-cordis/data/workdirs
findmnt -T /srv/teamspace-cordis/data/workdirs -n -o FSTYPE,TARGET,OPTIONS
sudo xfs_quota -x -c 'state -p' /srv/teamspace-cordis/data/workdirs
```

验收输出必须显示 `xfs` 与 `prjquota`（或 `pquota`），且 project quota 状态为启用；再安装配额助手并运行下方 `ensure` 和超限写入验收。将该 mount 配置与服务启动编排分开管理，避免卷未挂载时应用把普通根文件系统目录当成工作区使用。

应用首次领取 Agent 工作区时，会调用配置的配额助手登记唯一 XFS project ID 并设置每 Agent 的 soft/hard limit；生产模式未配置助手或登记失败时拒绝创建工作区。配额超限写入失败时，系统会在会话追加可见系统事件，并将 Agent、会话和错误写入服务日志。助手代码在 `deploy/teamspace-workdir-quota.py`，它只接受 `ensure AGENT_ID`，从 root 所有的配置文件读取固定工作区根目录和配额，不接受调用方传入任意路径。

部署时先将 `data/workdirs/` 建为独立 XFS 挂载点并启用 `prjquota`（或 `pquota`），再安装助手和 root 所有的配置：

```sh
sudo install -o root -g root -m 0755 deploy/teamspace-workdir-quota.py /usr/local/sbin/teamspace-workdir-quota
sudo install -d -o root -g root -m 0755 /etc/teamspace
sudo tee /etc/teamspace/workdir-quota.conf <<'EOF'
workdirs_root=/srv/teamspace-cordis/data/workdirs
service_user=teamspace
soft_limit=700m
hard_limit=768m
min_project_id=52000
max_project_id=59999
EOF
sudo chown root:root /etc/teamspace/workdir-quota.conf
sudo chmod 0640 /etc/teamspace/workdir-quota.conf
sudo install -d -o teamspace -g teamspace /srv/teamspace-cordis/data/workdirs
```

通过 `visudo` 仅允许服务账号免交互调用该固定助手，然后在应用 `.env` 设置 `WORKDIR_QUOTA_HELPER=/usr/local/sbin/teamspace-workdir-quota` 和 `WORKDIR_QUOTA_SUDO=1`。例如 sudoers 规则为 `teamspace ALL=(root) NOPASSWD: /usr/local/sbin/teamspace-workdir-quota ensure *`；助手会再次校验 Agent ID、固定目录、XFS 文件系统和配额挂载选项。先手动执行 `sudo /usr/local/sbin/teamspace-workdir-quota ensure a_quota_check`，再用 `xfs_quota -x -c 'report -h -p' /srv/teamspace-cordis/data/workdirs` 核对登记和限制，然后删除验收 Agent 前先人工检查其文件。助手不自动清空或删除 Agent 文件：工作区可能含有未共享的重要产物；清理需由管理员确认归档/保留后再处理。项目 ID 映射保持登记，避免误把旧配额分配给其他 Agent。

仓库提供 `deploy/teamspace-workdir-quota.sudoers` 作为规则模板。安装时用 `visudo` 校验，不要直接覆盖整份 `/etc/sudoers`：

```sh
sudo install -o root -g root -m 0440 deploy/teamspace-workdir-quota.sudoers /etc/sudoers.d/teamspace-workdir-quota
sudo visudo -cf /etc/sudoers.d/teamspace-workdir-quota
```

超限验收只能在与真实团队数据隔离的环境执行：可以是独立预发 Linux 主机，也可以是目标服务器上的专用 XFS 测试挂载，但必须使用独立的应用数据目录、数据库、配额配置和测试 Agent。不要降低生产配额，也不要向生产工作区写入大文件。先验证首次工作区领取生成唯一 project ID 和限额，再让测试 Agent 通过 `tool.workspace.write` 写入超过测试 hard limit 的内容；预期文件系统返回 `EDQUOT`/`ENOSPC`，工具失败，会话时间线出现“个人工作区达到或无法登记宿主机磁盘配额”系统事件，服务错误日志包含 `[workdir-quota]`、会话和 Agent 标识。还要在调试控制台日志页确认该 logger 记录已持久化。检查测试工作区文件后由管理员决定归档或删除；不要让测试脚本自动清理文件。

完成后将以下验收证据附到发布记录；不要记录 API 密钥、`.env` 全文或其他凭据：

- 主机/版本、工作区挂载点，以及 `findmnt` 的文件系统类型和生效选项。
- `xfs_quota state -p` 的启用状态；测试 Agent ID 对应的 project ID、soft/hard limit 和 `report -h -p` 输出。
- 首次领取结果，以及超限写入的工具结果、会话系统事件 ID 和 `[workdir-quota]` 日志检索结果。
- 测试工作区文件清点结果与管理员归档/保留/删除决定；project ID 映射保留情况。

记录须注明超限写入发生在隔离 XFS 测试挂载。若测试挂载位于目标生产服务器，仍要使用独立数据库、数据目录和测试 Agent；生产工作区只核对实际挂载、助手登记和限额，不执行超限写入。

## 向量模型切换与索引维护

部署前运行 `npm run migrate`，迁移 0034 为每个知识库分块增加向量模型标识。旧向量保留，但没有来源标识的向量不会参与语义检索；启动后由 `kb-embedder` 分批重建。模型标识包含 API 地址、模型 ID 和请求维度，不包含 API Key；单独轮换密钥不会使已完成的索引失效。

在后台 `/admin/models` 的“嵌入模型”页签查看“知识库向量索引”：当前模型、已完成/总分块数、失败原因和重试入口。启用另一模型后自动重建不兼容的分块；期间知识库与 Agent 检索使用关键词结果，完整索引就绪后恢复语义重排。失败和重启会保留已完成分块，重试仅处理剩余任务。日志搜索 `[kb-embedder]` 可查开始、完成和失败信息；持久进度保存在 settings 的 `kb.embeddingIndex`，分块模型标识保存在 `kb_chunks.embedding_model`。

`npm run verify:embedding-index` 使用隔离的内存 SQLite 和模拟供应商，验证旧数据重建、相同维度模型切换、进行中请求过期、失败重试及重启续传，不调用真实 API。

# 主应用生产部署流程

本项目以单实例 Node.js 服务运行，SQLite 数据库保存在 `data/database.db`。正式发布使用 `teamspace-cordis/` 仓库，不部署已弃用的 `teamspace/`。

## 首次部署

1. 在 Linux 主机创建专用运行账号和发布目录，安装 Node.js 22.5.0 或更新版本，以及 Docker Engine（Agent 代码执行依赖 Docker 隔离容器）。npm 会根据 `package.json` / `.npmrc` 强制检查 Node 版本。优先使用 rootless Docker；标准 Docker socket 的访问权限相当于主机管理员权限。检出经过验证的提交或版本标签。
2. 执行 `npm ci` 安装锁定依赖；复制 `.env.example` 为 `.env`，设置 `NODE_ENV=production`、监听地址和端口、日志时区，以及后台独立凭据 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`。生成 `SETTINGS_ENCRYPTION_KEY`（`openssl rand -base64 32`）并保存在部署密钥管理处；它用于加密数据库中的模型和搜索 API 密钥，必须与数据库备份分开备份，丢失后需重新录入 API 凭据。确保默认 `PATH` 中的 Node.js 至少为 22.5；只有需要固定某个 Node 安装时才设置 `NODE_BIN_DIR`（例如 `/usr/bin`）。生产密码至少 6 位，建议使用密码管理器生成的长随机值。不要把 `.env` 提交到 Git。
3. 首次启动前运行 `npm run migrate` 创建或升级 SQLite schema。后续版本升级前先运行 `npm run backup`，再运行迁移。
4. 执行 `npm run gate:static`。在隔离、合成数据的预发副本先用 `NODE_ENV=development` 启动候选版本，再执行 `npm run gate:runtime`；该门禁包含后台/Teamspace 可达性、Playwright UI 回归、写入型 `smoke` 和运行时验证。预发主机需安装可运行的 Chromium；非标准路径通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定。Runtime gate 会创建验收账号和会话、调整 seed demo 会话成员，并可能触发真实模型调用，因此不要对有真实团队数据的生产实例运行。随后使用独立 `.env`、数据库和密钥，以 `NODE_ENV=production` 重启隔离副本，核对 `/healthz`、后台管理员登录、Team 注册/登录及两类 token 互相拒绝；生产模式不要运行 `smoke` 或完整 `gate:runtime`，smoke 会主动拒绝生产环境。确认检查通过后再将版本切为当前发布。
5. 以专用账号运行 `npm start`。systemd 部署可使用仓库模板 `deploy/teamspace-cordis.service`：模板固定以 `teamspace` 用户运行 `/srv/teamspace-cordis` 下的 checkout，失败后自动重启，stdout/stderr 进入 journald。确保稳定路径、`.env` 和 `data/` 属于该账号；模板默认授予系统 Docker daemon 的 `docker` 组访问权，改用 rootless Docker 时移除此行并配置该账号的 rootless socket。按实际 Node/npm 安装位置调整 `PATH` 或 `/usr/bin/env`。不要以 root 运行应用。

```sh
sudo install -o root -g root -m 0644 deploy/teamspace-cordis.service /etc/systemd/system/teamspace-cordis.service
sudo systemctl daemon-reload
sudo systemctl enable --now teamspace-cordis
sudo systemctl status teamspace-cordis
journalctl -u teamspace-cordis -n 100 --no-pager
```

配额助手需要通过 sudo 更新 XFS project 映射，因此不要在 unit 中启用 `NoNewPrivileges=true` 或只读 `/etc` 沙箱，除非同时为助手设计并验收了相应的 systemd 文件权限例外。更新时用 `systemctl stop/start teamspace-cordis`；发布路径固定时无需改 unit。

## 预发验收与恢复演练

预发必须使用独立 checkout 根目录和独立 `.env`；应用数据目录相对当前工作目录位于 `data/`，因此不要让预发和生产共用 `data/`、端口或密钥。使用合成/脱敏数据启动预发服务，先运行 `npm run gate:static`，再在开发模式运行 `npm run gate:runtime`。另在生产模式检查启动、后台管理员认证、Team 用户认证及身份域隔离；仅使用隔离预发数据库执行会写数据的检查。确认登录、Agent 记忆追赶、`@AI` 回复、工具调用和文件访问都通过后，才允许生产发布。

恢复演练从预发快照开始：执行 `npm run backup -- --include-workdirs`，将快照复制到独立演练目录，恢复数据库、日志、上传、共享交付和工作区，使用对应 `SETTINGS_ENCRYPTION_KEY` 启动候选版本；核对 `/healthz`、`PRAGMA integrity_check`、成员会话访问、附件读取与加密 API 配置可解密。记录恢复用时、缺失数据和操作步骤。不得把生产快照直接恢复到开放的预发环境，也不得在生产库运行 smoke。

## 更新与回滚

更新按维护窗口执行：先在运行中的旧版本执行 `npm run backup`，确认快照完成；再停止 systemd 服务，检出候选版本并运行 `npm ci` 和 `npm run migrate`，最后启动新版本。示例：

```sh
npm run backup
sudo systemctl stop teamspace-cordis
git checkout <release-tag>
npm ci
npm run migrate
sudo systemctl start teamspace-cordis
```

不要让旧进程与迁移后的 schema 并行运行。启动后验证 `/healthz`、后台登录和 Teamspace 登录；写入型 smoke 只在隔离预发执行。若迁移或启动失败，停止服务并按下方流程恢复整套数据快照，再启动旧版本。`npm start` 会在启动时构建活动 UI 页面；构建失败会中止启动，不应复用旧构建产物掩盖失败。

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

超限验收只在隔离预发的专用 XFS 测试挂载和测试 Agent 上执行，不要降低生产配额或向生产工作区写入大文件。先验证首次工作区领取生成唯一 project ID 和限额，再让测试 Agent 通过 `tool.workspace.write` 写入超过测试 hard limit 的内容；预期文件系统返回 `EDQUOT`/`ENOSPC`，工具失败，会话时间线出现“个人工作区达到或无法登记宿主机磁盘配额”系统事件，服务错误日志包含 `[workdir-quota]`、会话和 Agent 标识。还要在调试控制台日志页确认该 logger 记录已持久化。检查工作区文件后由管理员决定归档或删除；不要让测试脚本自动清理用户文件。

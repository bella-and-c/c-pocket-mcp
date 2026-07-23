# VPS 自托管：用 Docker Compose 长期运行 Pocket

这套方案适合已经拥有 VPS、云主机或 24 小时在线 Docker 主机的用户。Pocket 与 Caddy 都由仓库中的 Compose 模板启动；Caddy 负责 HTTPS，Pocket 卡片和媒体附件保存在 Docker Volume 中。

如果你没有 VPS，也不想维护服务器，请改用 [Railway 托管方案](railway-hosting.md)。

## 一、准备条件

- 一台能够长期在线的 Linux 主机；
- Docker Engine 与 Docker Compose v2；
- 一个由你控制的域名或子域名；
- 域名的 `A` / `AAAA` 记录已经指向主机；
- 防火墙与云安全组允许公网访问 TCP `80` 和 `443`。

Pocket 本身不需要直接向公网暴露 `8787` 端口。公网流量只经过 Caddy。

## 二、下载与配置

```bash
git clone https://github.com/bella-and-c/c-pocket-mcp.git
cd c-pocket-mcp
cp deploy/.env.production.example deploy/.env.production
```

编辑 `deploy/.env.production`：

```dotenv
C_POCKET_DOMAIN=pocket.example.com

PORT=8787
HOST=0.0.0.0
C_POCKET_DATA_DIR=/app/data

C_POCKET_BRIDGE_TOKEN=<至少 32 位的独立随机值>
C_POCKET_MCP_PATH=/mcp/<至少 32 位的独立随机值>
C_POCKET_DROP_SECRET=<至少 48 位的独立随机值>
C_POCKET_ALLOWED_ORIGINS=

CMEMORY_BASE_URL=http://127.0.0.1:4282
CMEMORY_TOKEN=
```

三个入口秘密必须彼此不同，也不能复用账号密码。分别运行三次下面的命令生成随机值：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

真实的 `deploy/.env.production` 已被 Git 忽略，不要把它、Drop 地址或 Token 提交到仓库。

## 三、启动服务

```bash
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs --tail=100 pocket caddy
```

Caddy 在 DNS 正确且 `80`、`443` 可达时会自动申请并续期证书。健康检查应返回：

```bash
curl https://pocket.example.com/health
```

预期包含 `"ok":true` 与 `"storeReady":true`。

## 四、配置长期入口

假设域名是 `https://pocket.example.com`，那么：

```text
iPhone Drop: https://pocket.example.com/drop/<C_POCKET_DROP_SECRET>
Chat MCP:    https://pocket.example.com/mcp/<C_POCKET_MCP_PATH 的随机后缀>
```

先验证 `/health`，再分别测试 iPhone 分享和 `pocket_start_context`。不要在截图、日志或公开教程中展示真实入口。

## 五、更新

```bash
git pull --ff-only
docker compose -f deploy/compose.yaml up -d --build
```

更新镜像不会删除命名卷中的 Pocket 数据。更新后仍应检查容器状态、`/health` 和一条实际分享。

## 六、备份与恢复

Pocket 数据位于 Compose 命名卷 `pocket_data`。备份时应同时保存：

```text
/app/data/pocket-store.json
/app/data/media/
```

执行文件级备份前先暂停 Pocket 写入，避免 JSON 状态与媒体目录不一致。恢复时把两者放回同一个 Volume，再重启 Pocket 并检查 `/health` 与 MCP 列表。

不要只备份 Compose 文件：Compose 文件描述服务，真实卡片和附件在 Volume 中。

## 七、安全清单

- 只对公网开放 `80` 和 `443`；
- 不对公网映射 Pocket 的 `8787` 端口；
- 三个随机秘密互不相同；
- 不把 `.env.production`、真实数据或入口地址提交到 GitHub；
- 定期更新宿主机、Docker、Caddy 与 Pocket；
- 为 VPS 设置自动安全更新、SSH 密钥登录和防火墙；
- 若入口出现在录屏、截图或公开日志中，立即轮换对应秘密并重启服务。

## 八、什么时候不该选 VPS

如果你不想负责系统更新、证书故障、磁盘空间、备份与服务器账单，就不要为了 Pocket 专门购买 VPS。使用 [Railway 托管方案](railway-hosting.md) 会更省心，而且同样支持电脑关机后继续接收分享。

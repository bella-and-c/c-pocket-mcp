# Railway 托管：电脑关机后 Pocket 仍然在线

Railway 运行仓库根目录的 `Dockerfile`，为服务提供固定 HTTPS 域名，并把一个持久卷挂载到 `/app/data`。Pocket 的 JSON 卡片和媒体附件都写入该卷，因此重新部署或重启不会清空口袋。

这套方案不需要购买或维护 VPS。Railway 仍然是付费或按量计费的云托管服务；可以先用试用额度完成验收，再根据实际用量决定是否保留。

## 一、从 GitHub 创建服务

1. 登录 Railway，选择 **New Project → Deploy from GitHub repo**。
2. 选择 `bella-and-c/c-pocket-mcp`。
3. Railway 会读取根目录的 `Dockerfile` 和 `railway.json`。
4. 暂时不要生成公开地址，先完成变量和持久卷设置。

## 二、添加持久卷

在 Pocket 服务的 **Settings → Volumes** 中添加一个 Volume：

```text
Mount Path: /app/data
```

不要省略这一步。没有持久卷时，重新部署会丢失卡片和附件。

Pocket 使用单个 JSON 状态文件串行写入，因此生产环境应保持 **1 个副本**。带 Volume 的 Railway 服务本身也不支持多副本，这与当前数据模型一致。

## 三、配置变量和秘密

在服务的 **Variables → RAW Editor** 中填写：

```dotenv
HOST=0.0.0.0
C_POCKET_DATA_DIR=/app/data
C_POCKET_BRIDGE_TOKEN=<至少 32 位的独立随机值>
C_POCKET_MCP_PATH=/mcp/<至少 32 位的独立随机值>
C_POCKET_DROP_SECRET=<至少 48 位的独立随机值>
C_POCKET_ALLOWED_ORIGINS=
CMEMORY_BASE_URL=http://127.0.0.1:4282
CMEMORY_TOKEN=
```

不要手动设置 `PORT`。Railway 会在运行时注入端口，Pocket 会自动读取。

三个公开入口秘密必须彼此不同，也不要复用任何账号密码。可以在本机分别运行三次：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 四、生成固定 HTTPS 地址

部署成功且 `/health` 通过后，在 **Settings → Networking** 中点击 **Generate Domain**。Railway 会提供稳定的 `*.up.railway.app` 地址，并自动终止 HTTPS。

假设域名是：

```text
https://your-pocket.up.railway.app
```

那么两个长期入口是：

```text
iPhone Drop: https://your-pocket.up.railway.app/drop/<C_POCKET_DROP_SECRET>
Chat MCP:    https://your-pocket.up.railway.app/mcp/<C_POCKET_MCP_PATH 的随机后缀>
```

只在所有验收通过后，才把 iPhone 快捷指令和 Chat MCP 从 Quick Tunnel 地址切到这两个固定地址。

## 五、迁移现有口袋

真实数据绝不能提交到 GitHub。

1. 先停止本地 Pocket 写入，并备份本地 `pocket-store.json` 与 `media/`。
2. 使用 Railway CLI 的服务文件浏览器，把它们上传到运行中容器的 `/app/data`：

   ```bash
   railway service files browse
   ```

3. 确认远端最终结构为：

   ```text
   /app/data/pocket-store.json
   /app/data/media/...
   ```

4. 重启服务，再检查 `/health` 和 MCP 列表。

迁移期间不要让本地与云端同时接收新卡片，否则两个 JSON 状态会分叉。

## 六、断电验收

按顺序验证：

1. `GET https://<domain>/health` 返回 `ok: true`。
2. 从 iPhone 分享一条测试链接，收到简短中文回执。
3. Chat MCP 能调用 `pocket_start_context` 读到该卡片。
4. 在 Railway 重启服务后，卡片仍存在。
5. 关闭 Windows 电脑，再从 iPhone 分享第二条测试链接。
6. Chat 仍能读到第二条，证明链路不再依赖家里电脑。

## 边界

- 只有 Pocket 投递和 Pocket 卡片/附件迁往托管平台；Enervate 私人房间仍留在本机。
- C-Memory 当前仍是本机服务。电脑关机时，`memory_*` 工具可能不可用，但 Pocket 接收与读取不受影响。
- Railway 部署使用平台 HTTPS，不需要运行 Compose 里的 Caddy；`deploy/compose.yaml` 继续保留给 VPS 或自托管用户。
- 免费或试用额度、配额与价格可能变化，正式长期使用前应在 Railway 账单页设置用量上限。

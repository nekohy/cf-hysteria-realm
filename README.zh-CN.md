# cf-hysteria-realm

在 Cloudflare Workers 上实现的 Hy2 Realm 会合服务。完整支持原版 6 个 HTTP/SSE 端点，并按 realm 名称动态注册多个会话。

维护者：[Nekohy](https://github.com/nekohy)。

[English](README.md) · [技术文档](docs/technical.md)

## 架构

- **Cloudflare Workers**：HTTP API、认证、SSE 输出和 10 秒打洞等待。
- **Cloudflare D1**：持久化 realm 会话、客户端 IP 限额、nonce、打洞响应和离线事件队列。
- **Ably**：通过 REST + SSE 实时传递 `punch`、`heartbeat_ack` 和打洞响应。

不再使用 Durable Objects，也不需要 KV/D1 轮询。Hysteria 流量不经过本服务；这里只交换 UDP 打洞所需的元数据。

## 功能

- 多 realm 动态注册，共享同一个 `REALM_TOKEN`。
- 60 秒 session TTL、heartbeat 地址更新、10 秒 connect 等待与地址回退。
- 原版 `realm_taken`、`realm_limit_reached`、`ip_limit_reached` 语义。
- 每 realm 最多 16 个进行中的 connect，nonce 在不同 realm 间隔离。
- session、打洞状态和最多 16 条未送达事件持久化，SSE 重连时按事件原子认领补发。
- 可选的 Prometheus 核心指标接口。
- 无运行时依赖，Ably 使用原生 HTTP/SSE，无需 SDK。

## 部署

### 一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nekohy/cf-hysteria-realm)

1. 准备 Cloudflare 和 Ably 免费账号。Ably API Key 需要 **publish + subscribe** 权限，它只会保存在 Worker secret 中。
2. 点击上方按钮并授权 GitHub、Cloudflare。确认部署来源是 **nekohy/cf-hysteria-realm**。
3. 在部署页面填写 `REALM_TOKEN` 和 `ABLY_API_KEY`，确认 Worker 与 D1 名称后开始部署。Cloudflare 会自动创建 D1，部署脚本会应用 `migrations/` 中的初始 schema。
4. 部署完成后，在 Hy2 Realm 配置中使用 Worker URL 和 `REALM_TOKEN`。

如需 `/metrics`，部署后再设置独立的 `METRICS_TOKEN` secret。

### 手动部署

要求 Node.js 24+：

```bash
git clone https://github.com/nekohy/cf-hysteria-realm.git
cd cf-hysteria-realm
corepack pnpm install
corepack pnpm exec wrangler login
corepack pnpm exec wrangler d1 create cf-hysteria-realm
corepack pnpm exec wrangler secret put REALM_TOKEN
corepack pnpm exec wrangler secret put ABLY_API_KEY
corepack pnpm run deploy
```

无需手动填写 `database_id`；migration 和部署命令都使用绑定名 `DB`。`REALM_TOKEN` 应是足够长的随机字符串。若需要 `/metrics`，再执行：

```bash
corepack pnpm exec wrangler secret put METRICS_TOKEN
```

客户端与 realm server 的详细配置遵循 [Hy2 Realms 官方文档](https://v2.hysteria.network/docs/advanced/Realms/)。

## 配置

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `REALM_TOKEN` | Secret | 必填 | realm server 注册和 client connect 共用的 token。 |
| `ABLY_API_KEY` | Secret | 必填 | 具有 publish/subscribe 权限的完整 Ably API Key。 |
| `MAX_REALMS` | Variable | `65536` | 全局活跃 realm 上限；`0` 表示不限制。 |
| `MAX_REALMS_PER_IP` | Variable | `4` | 每个注册客户端 IP 的活跃 realm 上限；`0` 表示不限制。 |
| `REALM_NAME_PATTERN` | Variable | 原版正则 | 可选的 realm 名称正则。 |
| `TRUSTED_PROXY_HEADER` | Variable | `CF-Connecting-IP` | 可信客户端 IP 请求头；取逗号列表最左值。 |
| `METRICS_TOKEN` | Secret | 未设置 | 设置后启用 `GET /metrics`，使用独立 Bearer token。 |
| `DEBUG` | Variable | `false` | 排查问题时设为 `true`。 |

**安全提示：** 仅在可信代理会覆盖请求头时使用 `TRUSTED_PROXY_HEADER`，否则调用者可伪造 IP 绕过单 IP 限额。Cloudflare 直连部署使用默认的 `CF-Connecting-IP` 即可。

## 免费额度

免费额度均按账号共享，不是每个部署各一份：

- Cloudflare Workers Free：100,000 请求/天。
- Cloudflare D1 Free：每天 5M rows read、100K rows written，5 GB 存储。
- Ably Free：500 并发连接、500 峰值频道、6M 消息/月。

本实现不在长连接中查询 D1，但 heartbeat 和业务事件仍会消耗 D1 写入及 Ably 消息。实际可承载的 realm 数取决于心跳、打洞频率和账号内其他项目，不能视为无限额度。

## 本地开发与测试

```bash
cp .dev.vars.example .dev.vars
# 填入真实 REALM_TOKEN 和 ABLY_API_KEY
corepack pnpm run db:migrate:local
corepack pnpm run dev
```

运行检查：

```bash
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm exec wrangler deploy --dry-run
```

测试使用内存 SQLite 和模拟 Ably，不会访问真实服务。

## License

MIT

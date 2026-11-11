# cf-hysteria-realm

在 Cloudflare Workers 上运行的 Hy2 Realm 会合服务，支持原版 HTTP/SSE 协议和动态多 realm。

维护者：[Nekohy](https://github.com/nekohy) · [English](README.md) · [技术文档](docs/technical.md)

## 特性

- 完整实现注册、注销、heartbeat、SSE、connect 和 connect response。
- 使用 D1 持久化会话、限额、打洞状态及 16 条事件队列；Ably 负责实时通知。
- 支持原版 409/429 限额语义、60 秒 TTL、10 秒等待与地址回退。
- 无 Durable Objects、无数据库轮询、无运行时 npm 依赖。

本服务只交换 UDP 打洞元数据，不中继 Hysteria 流量。

## 一键部署

准备 Cloudflare 和 Ably 免费账号，并创建具有 **publish + subscribe** 权限的 Ably API Key。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nekohy/cf-hysteria-realm)

1. 点击按钮并授权 GitHub、Cloudflare，确认来源为 `nekohy/cf-hysteria-realm`。
2. 填写 `REALM_TOKEN` 和 `ABLY_API_KEY`。Cloudflare 会创建 D1，部署脚本会应用初始 schema。
3. 在 Hy2 Realm 配置中使用部署后的 Worker URL 和 `REALM_TOKEN`。

## 手动部署

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

无需填写 `database_id`，migration 和部署均使用 `DB` 绑定。需要 `/metrics` 时，再执行 `wrangler secret put METRICS_TOKEN`。

## 配置

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `REALM_TOKEN` | 必填 Secret | realm server 与 client 共用的随机 token。 |
| `ABLY_API_KEY` | 必填 Secret | 具有 publish/subscribe 权限的完整 Ably Key。 |
| `MAX_REALMS` | `65536` | 全局活跃 realm 上限；`0` 不限制。 |
| `MAX_REALMS_PER_IP` | `4` | 单 IP 活跃 realm 上限；`0` 不限制。 |
| `REALM_NAME_PATTERN` | 原版正则 | 可选 JavaScript 正则。 |
| `TRUSTED_PROXY_HEADER` | `CF-Connecting-IP` | 可信客户端 IP 请求头。 |
| `METRICS_TOKEN` | 未设置 | 设置后启用带独立 Bearer 认证的 `/metrics`。 |
| `DEBUG` | `false` | 排查问题时设为 `true`。 |

仅让可信代理覆盖 `TRUSTED_PROXY_HEADER`，否则单 IP 限额可被伪造请求头绕过。

## 本地开发与测试

```bash
cp .dev.vars.example .dev.vars  # 填入真实 token 和 Ably Key
corepack pnpm run db:migrate:local
corepack pnpm run dev
```

```bash
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm exec wrangler deploy --dry-run
```

Workers、D1 和 Ably 的免费额度均按账号共享；实际容量取决于心跳、打洞频率及账号内其他项目。协议、事件队列和运行细节见[技术文档](docs/technical.md)。

## License

MIT

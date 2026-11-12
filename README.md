# cf-hysteria-realm

在 Cloudflare Workers 上运行的 Hy2 Realm 会合服务，支持原版 HTTP/SSE 协议和动态多 realm。

维护者：[Nekohy](https://github.com/nekohy) · [技术文档](docs/technical.md)

## 一键部署

准备 Cloudflare 和 Ably 免费账号，并创建具有 **publish + subscribe** 权限的 Ably API Key。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nekohy/cf-hysteria-realm)

1. 点击按钮并授权 GitHub、Cloudflare，确认来源为 `nekohy/cf-hysteria-realm`。
2. 填写 `REALM_TOKEN` 和 `ABLY_API_KEY`。Cloudflare 会创建 D1，Worker 会在首次访问或冷启动时自动创建数据表和索引。
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

无需填写 `database_id`，部署使用 `DB` 绑定。Worker 会在首次访问或冷启动时自动创建数据表和索引。需要 `/metrics` 时，再执行 `wrangler secret put METRICS_TOKEN`。

## 配置

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `REALM_TOKEN` | 必填 Secret | realm server 与 client 共用的随机 token。 |
| `ABLY_API_KEY` | 必填 Secret | 具有 publish/subscribe 权限的完整 Ably Key。 |
| `METRICS_TOKEN` | 未设置 | 设置后启用带独立 Bearer 认证的 `/metrics`。 |
| `DEBUG` | `false` | 排查问题时设为 `true`。 |

## 本地开发与测试

```bash
cp .dev.vars.example .dev.vars  # 填入真实 token 和 Ably Key
corepack pnpm run dev
```

本地开发无需手动初始化数据库，Worker 会在首次访问或冷启动时自动建表。

```bash
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm exec wrangler deploy --dry-run
```

## License

MIT

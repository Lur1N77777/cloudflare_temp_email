# GitHub Actions 自动更新与部署说明

本仓库已按官方文档配置 GitHub Actions，用于同步上游 `dreamhunter2333/cloudflare_temp_email` 并自动部署 Cloudflare Worker 后端和 Pages 前端。

## 已配置的工作流

- `Upstream Sync`：每天北京时间 03:00 同步上游更新，也可以手动运行。
- `Deploy Backend`：上游同步成功后、推送 tag 后或手动运行时部署 Worker。
- `Deploy Frontend`：上游同步成功后、推送 tag 后或手动运行时部署 Cloudflare Pages 前端。

## 必需 Secrets

你已经配置：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

使用自动生成 `wrangler.toml` 时还必须配置：

- `TEMP_MAIL_JWT_SECRET`：Worker 的 `JWT_SECRET`，建议使用 `openssl rand -hex 32` 生成。
- `TEMP_MAIL_ADMIN_PASSWORDS_JSON`：管理员密码数组，例如 `["5277"]`。

可选：

- `BACKEND_TOML`：如果你想完全手写 `worker/wrangler.toml`，可以配置这个 secret；配置后工作流会优先使用它。
- `FRONTEND_ENV`：如果你想完全手写前端 `.env.prod`，可以配置这个 secret。
- `TEMP_MAIL_RESEND_TOKEN_LOVEN7_COM`：`loven7.com` 的 Resend API Token，会在每次 Worker 部署后写入 Cloudflare Worker secret `RESEND_TOKEN_LOVEN7_COM`。
- `TEMP_MAIL_RESEND_TOKEN_LMHZEQ_FUN`：`lmhzeq.fun` 的 Resend API Token，会在每次 Worker 部署后写入 Cloudflare Worker secret `RESEND_TOKEN_LMHZEQ_FUN`。
- `TEMP_MAIL_RESEND_TOKEN`：可选，全局 Resend API Token，对应 Worker secret `RESEND_TOKEN`。
- `TEMP_MAIL_SMTP_CONFIG`：可选，SMTP JSON 配置，对应 Worker secret `SMTP_CONFIG`。
- `TEMP_MAIL_WORKER_SECRETS_JSON`：可选，额外 Worker secrets 的 JSON 对象，例如 `{"RESEND_TOKEN_EXAMPLE_COM":"..."}`。

如果没有配置 `BACKEND_TOML`，当前工作流会自动生成 `wrangler.toml`，并通过 Cloudflare API 自动解析 D1 数据库。

## 已配置的 Repository Variables

这些变量用于自动生成部署配置：

- `TEMP_MAIL_WORKER_NAME`：Worker 名称，默认 `cloudflare_temp_email`
- `TEMP_MAIL_WORKER_ROUTE`：Worker 自定义域名，例如 `apimail.lmhzeq.fun`
- `TEMP_MAIL_D1_NAME`：D1 数据库名称；如果该名称找不到且账户只有一个 D1，会自动使用唯一的 D1
- `TEMP_MAIL_FRONTEND_NAME`：Cloudflare Pages 项目名
- `TEMP_MAIL_FRONTEND_API_BASE`：前端访问的 Worker API 根地址，不能以 `/` 结尾
- `TEMP_MAIL_DOMAINS_JSON`：所有邮箱域名
- `TEMP_MAIL_DEFAULT_DOMAINS_JSON`：默认可用域名
- `TEMP_MAIL_RANDOM_SUBDOMAIN_DOMAINS_JSON`：允许随机子域名的基础域名
- `TEMP_MAIL_USER_ROLES_JSON`：用户角色域名规则
- `TEMP_MAIL_ENABLE_SEND_MAIL_BINDING`：是否在 Worker 中绑定 Cloudflare `send_email` 发信通道；需要发信时设为 `true`
- `TEMP_MAIL_SEND_MAIL_REMOTE`：可选，设为 `true` 时生成 `{ name = "SEND_MAIL", remote = true }`，用于 Cloudflare Email Service 发信
- `TEMP_MAIL_SEND_MAIL_DOMAINS_JSON`：可选，限制哪些发件域名可以走 `SEND_MAIL` binding；不配置时允许所有已配置邮箱域名

## 敏感变量处理

工作流生成的 `wrangler.toml` 会接管 Worker 的 `[vars]` 配置，因此不能只依赖 `keep_vars = true` 保存敏感运行变量。为了避免部署后出现 `JWT_SECRET is not set` 或管理员入口失效，当前配置要求把必要敏感项放进 GitHub Secrets：

- `TEMP_MAIL_JWT_SECRET`：必需。
- `TEMP_MAIL_ADMIN_PASSWORDS_JSON`：必需，例如 `["5277"]`。
- `TEMP_MAIL_PASSWORDS_JSON`：可选，只有需要站点访问密码时配置，例如 `["site-password"]`。

## 首次使用

1. 打开 GitHub 仓库 Actions 页面。
2. 确认 `Upstream Sync`、`Deploy Backend`、`Deploy Frontend` 都已启用。
3. 手动运行一次 `Deploy Backend`。
4. 手动运行一次 `Deploy Frontend`。
5. 之后每天会自动同步上游并触发部署。

如果 `Deploy Backend` 提示账户下有多个 D1 数据库且找不到 `TEMP_MAIL_D1_NAME`，请把 `TEMP_MAIL_D1_NAME` 改成当前线上使用的 D1 数据库名称。

## 自动同步策略

`Upstream Sync` 现在不是强制覆盖，而是每天从 `dreamhunter2333/cloudflare_temp_email` 拉取 `main` 并 merge 到当前 fork。这样可以保留本仓库的 GitHub Actions 自动部署适配、Secrets 写回逻辑和本地文档，同时继续获得上游更新。若只在通用源码处发生复杂冲突，workflow 会失败并保留现场，避免误覆盖本地配置。

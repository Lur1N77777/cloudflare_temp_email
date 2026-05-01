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

可选但推荐：

- `BACKEND_TOML`：如果你想完全手写 `worker/wrangler.toml`，可以配置这个 secret；配置后工作流会优先使用它。
- `FRONTEND_ENV`：如果你想完全手写前端 `.env.prod`，可以配置这个 secret。

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

## 敏感变量处理

工作流生成的 `wrangler.toml` 默认不会写入：

- `JWT_SECRET`
- `ADMIN_PASSWORDS`
- `PASSWORDS`

原因是现有 Worker 已经配置了这些变量，`keep_vars = true` 会在部署时尽量保留现有值，避免更新后旧邮箱 JWT 失效或管理员密码被覆盖。

如果之后需要从零部署或显式覆盖，可以新增这些 secrets：

- `TEMP_MAIL_JWT_SECRET`
- `TEMP_MAIL_ADMIN_PASSWORDS_JSON`，例如 `["123","456"]`
- `TEMP_MAIL_PASSWORDS_JSON`，例如 `["site-password"]`

## 首次使用

1. 打开 GitHub 仓库 Actions 页面。
2. 确认 `Upstream Sync`、`Deploy Backend`、`Deploy Frontend` 都已启用。
3. 手动运行一次 `Deploy Backend`。
4. 手动运行一次 `Deploy Frontend`。
5. 之后每天会自动同步上游并触发部署。

如果 `Deploy Backend` 提示账户下有多个 D1 数据库且找不到 `TEMP_MAIL_D1_NAME`，请把 `TEMP_MAIL_D1_NAME` 改成当前线上使用的 D1 数据库名称。

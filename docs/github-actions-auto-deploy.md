# GitHub Actions 部署向导

本向导把一个新的 Fork 部署到独立的 Cloudflare 资源。公开仓库没有预置域名、资源 ID 或凭据。所有示例值都必须替换。

## 工作流实际行为

| 工作流 | 触发方式 | 会做什么 | 不会做什么 |
| --- | --- | --- | --- |
| `Upstream Sync` | 每天定时、手动 | 将上游合并到自动化分支并创建/刷新 PR | 不改 `main`、不打 Tag、不部署 |
| `Deploy Backend` | 仅手动 | 测试、构建并部署 Worker；同一次部署原子写入 Worker Secrets | 不由同步 PR 或 Tag 自动触发 |
| `Deploy Frontend` | 仅手动 | 构建并部署 Cloudflare Pages | 不由同步 PR 或 Tag 自动触发 |
| `Tag Build CI` | 推送 Tag | 构建通用资产、校验和并创建 GitHub Release | 不包含任何实例密钥 |

推荐先手动部署验收，稳定后再通过 Fork Tag 发布。自动同步只负责提出变更，避免未经审查的上游代码直接进入生产。

在仓库 `Settings → Actions → General → Workflow permissions` 中允许工作流读写仓库内容，并允许 GitHub Actions 创建 Pull Request；否则 `Upstream Sync` 会安全失败，但不会影响手动部署。

## 1. Cloudflare API Token

创建最小权限 Token，并限制到用于部署的账户。按你启用的组件授予：

- Workers Scripts：Edit
- D1：Edit
- Pages：Edit（部署前端时）
- Account Settings：Read
- Workers Routes：Edit（由工作流管理自定义路由时）

不要使用 Global API Key。复制 Token 后直接保存到 GitHub Secret，不要写入 Issue、日志或仓库文件。

## 2. 必需 Repository Secrets

进入 `Settings → Secrets and variables → Actions → Secrets`：

| 名称 | 值 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | Secret，即使它不是密码也不要写入公共源码 |
| `CLOUDFLARE_API_TOKEN` | 上一步的最小权限 Token | Secret |
| `TEMP_MAIL_JWT_SECRET` | 至少 32 字节随机值 | 可用本地 `openssl rand -hex 32` 生成 |
| `TEMP_MAIL_ADMIN_PASSWORDS_JSON` | `["replace-with-a-random-password"]` | 必须是 JSON 字符串数组；请替换为随机长密码 |

文档故意不提供可复用管理员密码。配置完以后不要把 Secret 截图或复制回聊天。

## 3. 最小 Repository Variables

进入同一页面的 `Variables` 标签：

| 名称 | 示例 | 必需 |
| --- | --- | --- |
| `TEMP_MAIL_WORKER_NAME` | `my-temp-mail-worker` | 是 |
| `TEMP_MAIL_D1_NAME` | `my-temp-mail-db` | 是 |
| `TEMP_MAIL_DOMAINS_JSON` | `["mail.example.com"]` | 是 |
| `TEMP_MAIL_DEFAULT_DOMAINS_JSON` | `["mail.example.com"]` | 建议 |
| `TEMP_MAIL_WORKER_ROUTE` | `api.example.com` | 可选；留空使用 workers.dev |
| `TEMP_MAIL_FRONTEND_NAME` | `my-temp-mail-web` | 部署 Pages 时 |
| `TEMP_MAIL_FRONTEND_API_BASE` | `https://api.example.com` | 部署 Pages 时 |
| `TEMP_MAIL_FRONTEND_URL` | `https://mail.example.com` | Webhook/链接需要时 |

品牌变量均为普通配置，不应包含签名或鉴权信息：

- `TEMP_MAIL_VERIFICATION_MAIL_BRAND_NAME`：例如 `Example Mail`。
- `TEMP_MAIL_VERIFICATION_MAIL_LOGO_URL`：可选，公开 HTTPS 图片；留空会显示可靠的文本标识。

其余可选变量见 `worker/wrangler.toml.template` 与 VitePress 变量文档。JSON 变量必须是合法 JSON，布尔变量使用 `true`/`false`。

## 4. 可选 Secrets

- `BACKEND_TOML`：完整的 `worker/wrangler.toml`。配置后将跳过自动生成，适合高级用户。
- `FRONTEND_ENV`：完整前端 `.env.prod`。
- `TEMP_MAIL_PASSWORDS_JSON`：站点访问密码 JSON 数组。
- `TEMP_MAIL_RESEND_TOKEN`：全局 Resend Token。
- `TEMP_MAIL_SMTP_CONFIG`：SMTP JSON 配置。
- `TEMP_MAIL_WORKER_SECRETS_JSON`：额外 Worker Secrets 的 JSON 对象。例如使用某域名专用 Resend Token 时，可填写 `{"RESEND_TOKEN_EXAMPLE_COM":"provider-token"}`；键名按 Worker 约定生成，值绝不能放在 Variables。
- `TEMP_MAIL_KV_ID`：可选 KV namespace ID；没有使用旧 KV 验证流程时可不配。

不要创建带个人域名的专用 GitHub Secret 名。域名专用 provider secret 统一放入 `TEMP_MAIL_WORKER_SECRETS_JSON`，公共工作流无需知道实例域名。

## 5. 第一次部署

1. 在 Actions 手动运行 `Deploy Backend`。
2. 工作流只查找你显式填写的 `TEMP_MAIL_D1_NAME`；找不到时创建这个精确名称，并且只对刚创建的空库执行一次 `db/schema.sql`。它不会借用账户里“唯一一个”但名称不同的数据库。
3. 工作流完成 lint、测试和 dry-run build 后，把代码与 JWT、管理员/站点密码等 Secrets 在同一次 Worker 部署中提交，避免先上线无 Secret 的中间版本。
4. 在 Cloudflare Email Routing 中把目标域名的 Catch-all 指向这个 Worker。
5. 需要自带前端时，手动运行 `Deploy Frontend`。

不要对已有 D1 重新执行 `schema.sql`。升级旧库前先导出备份，再按版本只应用缺失迁移。

## 6. 验收

- Worker 根地址和公开设置接口返回 200。
- 创建一个合成测试地址并成功收一封测试邮件。
- 管理员登录成功，错误密码不会泄露内部错误。
- 启用发信时，测试发信、重复请求幂等与额度恢复。
- 启用注册时，测试验证码、重复注册拦截和账号登录。
- 删除测试用户、测试邮件和临时地址。

## 7. 更新与发布

`Upstream Sync` 只会创建 PR。合并前查看冲突、迁移、依赖与认证变更，并等待 CI。通过发布门禁后创建 `v上游版本-loven7.修订号` Tag；`Tag Build CI` 会创建 Release 并上传校验文件。

完整策略见 [fork-release-policy.md](fork-release-policy.md)。

## 常见失败

- **找不到 D1**：确认 `TEMP_MAIL_D1_NAME` 与 Cloudflare 控制台完全一致。
- **多个 D1 时停止**：这是安全保护；设置精确名称后重跑。
- **JWT_SECRET / ADMIN_PASSWORDS 缺失**：确认放在 Repository Secrets，而不是 Variables。
- **Logo 不显示**：确认是无需登录即可访问的 HTTPS 图片；留空可使用文本标识。
- **前端请求错 API**：检查 `TEMP_MAIL_FRONTEND_API_BASE`，不能指向另一个实例。

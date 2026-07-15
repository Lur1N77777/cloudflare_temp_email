<!-- markdownlint-disable-file MD033 -->
# Cloudflare Temp Email · Loven7 Fork

> 这是 **Loven7 维护的 Fork**：在上游稳定版本之上补充生产安全、并发一致性、账号体系与可维护部署能力。公开仓库只保存通用源码和示例配置，不保存任何维护者的域名、Cloudflare 资源 ID、密码、Token 或私有部署文件。

[English](README_EN.md) · [安全策略](SECURITY.md) · [贡献指南](CONTRIBUTING.md) · [更新日志](CHANGELOG.md) · [Release](https://github.com/Lur1N77777/cloudflare_temp_email/releases)

## 项目关系

| 项目 | 定位 | 维护与兼容边界 |
| --- | --- | --- |
| [上游项目](https://github.com/dreamhunter2333/cloudflare_temp_email) | Cloudflare 临时邮箱的原始实现 | 上游功能与通用修复会通过 PR 审核后同步；本 Fork 不承诺未审查的上游提交可直接上线 |
| 本仓库 | Worker、D1、邮件路由与上游 Vue 前端 | Loven7 维护的公共核心；适合独立部署，也为管理套件提供兼容 API |
| [Loven7 Mail Cloudflare 管理套件](https://github.com/Lur1N77777/loven7-mail-cloudflare-suite) | 可选的增强管理后台与 Webmail | 独立发布、独立配置；不是运行本仓库的必需组件 |

本 Fork 重点维护：认证与令牌撤销、并发验证码、收发信幂等、额度原子预占、入站去重、游标分页、邮件 flags、安全日志和自动化发布。上游独有界面问题应优先向上游反馈；Fork 差异、部署脚本与安全问题由本仓库处理，详见 [支持边界](docs/fork-release-policy.md)。

## 主要能力

- Cloudflare Workers + D1 + Email Routing，无常驻服务器。
- Vue 3 响应式前端、管理后台、用户注册登录、邮箱地址密码。
- 收件、发件、附件、转发、Webhook、Telegram、SMTP/IMAP 代理。
- PBKDF2 密码保护、登录限流、JWT 类型与版本校验。
- 验证码、发信额度和幂等请求的 D1 并发保护。
- 可选 R2/S3、Workers AI、Turnstile、Resend 与 `send_email` binding。

## 选择部署方式

- **第一次部署（推荐）**：使用 [GitHub Actions 部署向导](docs/github-actions-auto-deploy.md)，配置一次 Secrets/Variables 后手动触发。
- **希望完全掌控配置**：按下方“手动部署”执行。
- **要使用增强管理后台**：先部署本仓库 Worker，再部署独立的 [管理套件](https://github.com/Lur1N77777/loven7-mail-cloudflare-suite)。

## 手动部署

### 1. 准备

需要 Node.js 24、pnpm 10、一个已接入 Cloudflare 的域名，以及开启 Email Routing 的 Cloudflare 账户。安装并登录 Wrangler：

```bash
corepack enable
pnpm dlx wrangler login
git clone https://github.com/Lur1N77777/cloudflare_temp_email.git
cd cloudflare_temp_email
```

### 2. 创建并初始化 D1

```bash
cd worker
pnpm install --frozen-lockfile
pnpm exec wrangler d1 create temp-email-db
pnpm exec wrangler d1 execute temp-email-db --file=../db/schema.sql --remote
```

复制 `worker/wrangler.toml.template` 为 `worker/wrangler.toml`，只需先修改四项：

1. `name`：Worker 名称。
2. `DOMAINS` 与 `DEFAULT_DOMAINS`：你的收件域名，例如 `mail.example.com`。
3. `database_name`：上一步的 D1 名称。
4. `database_id`：上一步命令返回的 D1 ID。

`wrangler.toml` 已被 Git 忽略，不要取消忽略或提交它。

### 3. 安全写入密钥并部署 Worker

下面命令会交互式读取值，不会把值写进仓库。`ADMIN_PASSWORDS` 必须是 JSON 数组；请使用随机长密码。

```bash
pnpm exec wrangler secret put JWT_SECRET
pnpm exec wrangler secret put ADMIN_PASSWORDS
pnpm run lint
pnpm test
pnpm run deploy
```

把 Cloudflare Email Routing 的 Catch-all 规则指向刚部署的 Worker。然后访问 Worker 根地址，确认返回成功响应。

### 4. 部署自带前端（可选）

```bash
cd ../frontend
pnpm install --frozen-lockfile
cp .env.example .env.prod
# 编辑 .env.prod：VITE_API_BASE=https://api.example.com
pnpm run build
pnpm exec wrangler pages deploy dist --project-name temp-email-web
```

Windows PowerShell 可用 `Copy-Item .env.example .env.prod` 替代 `cp`。部署后至少验收：公开设置接口、创建地址、收件、管理员登录；启用用户功能时再验收注册验证码和登录。

更多变量、现有数据库升级和故障排查见 [VitePress 快速开始](vitepress-docs/docs/zh/guide/quick-start.md)。

## 验证码邮件品牌

公开版不依赖任何外部 Logo，默认显示文本标识，因此不会出现图片加载失败。需要自定义时设置普通 Worker Variables：

```toml
VERIFICATION_MAIL_BRAND_NAME = "Example Mail"
VERIFICATION_MAIL_LOGO_URL = "https://assets.example.com/mail-logo.png"
```

Logo 必须是公开可访问的 HTTPS 图片；不合法或缺失时自动回退为文本标识。不要把需要鉴权的图片 URL、签名 URL 或私有域名写入公开仓库。

## 给 AI Agent 的部署提示词

把下面整段复制给执行部署的 AI Agent，并在最后单独提供你的非敏感部署选择。密码、Token 应由你在 Cloudflare/GitHub 界面填写，或通过交互式命令输入，不要发给 Agent：

```text
你是 Cloudflare 部署执行 Agent。目标是把本仓库部署为一个新的、与维护者生产环境完全隔离的实例。

强制规则：
1. 先完整阅读 README.md、docs/github-actions-auto-deploy.md、SECURITY.md 和 worker/wrangler.toml.template；不得凭经验猜变量名。
2. 先做只读检查：git status、Node/pnpm/Wrangler 版本、Cloudflare 当前账户、待使用的 D1/Pages/Worker 名称。发现同名生产资源时停止并询问，禁止覆盖。
3. 永远不要输出、回显、写入文件或提交 JWT_SECRET、管理员密码、API Token、Cloudflare 资源凭据。密钥只允许由用户在网页 Secret 表单填写，或使用 wrangler secret put 交互输入。
4. 所有示例值（example.com、占位 ID、示例密码）都必须替换；仍存在占位符时禁止部署。
5. 新建 D1 后只对全新空库执行 db/schema.sql。已有数据库必须先导出备份，再逐个检查并应用缺失迁移；禁止重复执行 ALTER 迁移。
6. 部署前依次运行 worker 的 frozen install、lint、test、build；任何一步失败都停止，不得跳过或用 --force。
7. 先部署 Worker 并做公开健康探针，再配置 Email Routing；之后才部署前端。前端 VITE_API_BASE 必须指向本次新 Worker。
8. 不修改 DNS、Catch-all、GitHub main、Release 或现有 Cloudflare 资源，除非用户明确授权该具体操作。
9. 验收至少包含：公开设置 200、创建测试地址、接收测试邮件、管理员登录；启用注册时还要验证验证码发送、重复注册拦截和登录。测试数据完成后删除。
10. 最终只汇报资源名称、公开 URL、测试结果和仍需用户完成的步骤；密钥与完整资源 ID 一律脱敏。

执行顺序：盘点 -> 给出将创建/修改的资源清单 -> 等待用户确认破坏性操作 -> 配置 -> 测试 -> 部署 -> 探针 -> 清理测试数据 -> 汇报。任何信息不足时提出一个最小问题，不得自行选择用户域名或现有生产资源。
```

建议给 Agent 的输入只包含：Cloudflare 账户显示名称、计划使用的 Worker/D1/Pages 名称、收件域名、是否部署前端、是否启用用户注册。更完整的逐项清单见 [Actions 部署向导](docs/github-actions-auto-deploy.md)。

## 开发与贡献

```bash
cd worker
pnpm install --frozen-lockfile
pnpm run lint
pnpm test
pnpm run build
```

提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。公开仓库禁止提交 `.dev.vars`、`wrangler.toml`、数据库导出、私有域名或任何凭据。发现漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。

## 发布与上游同步

- 定时任务只创建可审查的上游同步 PR，不会直接覆盖 `main`，也不会自动部署。
- Fork Release 使用 `v上游版本-loven7.修订号`，例如 `v1.10.0-loven7.1`。
- 推送版本 Tag 后，工作流构建资产、生成 SHA-256 校验文件，并创建或更新 GitHub Release。
- 生产实例的私有配置应保存在 Cloudflare/GitHub Secrets 或独立私有配置仓库，不进入此公共 Fork。

完整策略见 [Fork 发布策略](docs/fork-release-policy.md)。

## 许可证与致谢

本项目遵循 [MIT License](LICENSE)。感谢 [dreamhunter2333/cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) 及其贡献者；Fork 保留上游版权与提交历史。

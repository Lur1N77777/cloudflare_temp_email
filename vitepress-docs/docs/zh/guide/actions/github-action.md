# 通过 Github Actions 部署

::: warning 注意
目前只支持 worker 和 pages 的部署。
有问题请通过 `Github Issues` 反馈，感谢。

`worker.dev` 域名在中国无法访问，请自定义域名
:::

## 部署步骤

### Fork 仓库并启用 Actions

- 在 GitHub fork 本仓库
- 打开仓库的 `Actions` 页面
- 找到 `Deploy Backend` 点击 `enable workflow` 启用 `workflow`
- 如果需要前后端分离并直连 Worker, 找到 `Deploy Frontend` 点击 `enable workflow` 启用 `workflow`
- 如果需要通过 Page Functions 转发后端请求的 Pages 部署, 找到 `Deploy Frontend with page function` 点击 `enable workflow` 启用 `workflow`

### 配置 Secrets

然后在仓库页面 `Settings` -> `Secrets and variables` -> `Actions` -> `Repository secrets`, 添加以下 `secrets`:

- 公共 `secrets`

   | 名称                    | 说明                                                                                                            |
   | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID, [参考文档](https://developers.cloudflare.com/workers/wrangler/ci-cd/#cloudflare-account-id) |
   | `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token, [参考文档](https://developers.cloudflare.com/workers/wrangler/ci-cd/#api-token)           |

- worker 后端 `secrets`

   | 名称                           | 说明                                                                                                                                    |
   | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
   | `BACKEND_TOML`                 | 后端配置文件，[参考此处](/zh/guide/cli/worker.html#修改-wrangler-toml-配置文件)                                                         |
   | `TEMP_MAIL_JWT_SECRET`         | 当未配置 `BACKEND_TOML`、由 workflow 自动生成 `worker/wrangler.toml` 时必需。对应 Worker 的 `JWT_SECRET`，建议使用 `openssl rand -hex 32` 生成 |
   | `TEMP_MAIL_ADMIN_PASSWORDS_JSON` | 当未配置 `BACKEND_TOML`、由 workflow 自动生成 `worker/wrangler.toml` 时必需。管理员密码 JSON 数组，例如 `["123456"]` |
   | `TEMP_MAIL_PASSWORDS_JSON`      | (可选) 当未配置 `BACKEND_TOML`、由 workflow 自动生成 `worker/wrangler.toml` 时使用。站点访问密码 JSON 数组，例如 `["site-password"]` |
   | `TEMP_MAIL_RESEND_TOKEN`        | (可选) 全局 Resend API Token，部署后会自动写入 Worker secret `RESEND_TOKEN` |
   | `TEMP_MAIL_RESEND_TOKEN_<DOMAIN>` | (可选) 域名级 Resend API Token，例如 `TEMP_MAIL_RESEND_TOKEN_EXAMPLE_COM` 会写入 Worker secret `RESEND_TOKEN_EXAMPLE_COM`。域名需大写，`.` 替换为 `_` |
   | `TEMP_MAIL_SMTP_CONFIG`         | (可选) SMTP JSON 配置，部署后会自动写入 Worker secret `SMTP_CONFIG` |
   | `TEMP_MAIL_WORKER_SECRETS_JSON` | (可选) 额外 Worker secrets 的 JSON 对象，例如 `{"RESEND_TOKEN_EXAMPLE_COM":"..."}` |
   | `DEBUG_MODE`                   | (可选) 是否开启调试模式，配置为 `true` 开启, 默认 worker 部署日志不会输出到 Github Actions 页面，开启后会输出                           |
   | `BACKEND_USE_MAIL_WASM_PARSER` | (可选) 是否使用 wasm 解析邮件，配置为 `true` 开启, 功能参考 [配置 worker 使用 wasm 解析邮件](/zh/guide/feature/mail_parser_wasm_worker) |
   | `USE_WORKER_ASSETS`            | (可选) 部署带有前端资源的 Worker, 配置为 `true` 开启                                                                                    |

- pages 前端 `secrets`

   > [!warning] 注意
   > 如果选择部署带有前端资源的 Worker, 则无须配置这些 `secrets`

   | 名称               | 说明                                                                                                                                                                                      |
   | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `FRONTEND_ENV`     | `Deploy Frontend` workflow 使用的前端配置文件，请复制 `frontend/.env.example` 的内容，[并参考此处修改](/zh/guide/cli/pages.html)。如果是前后端分离直连 Worker，`VITE_API_BASE` 应填写后端 Worker API 根地址，并且以 `https://` 开头、末尾不要带 `/`。地址配置错误时，常见现象是前端报 `map` 错误或接口返回 `405` |
   | `FRONTEND_NAME`    | 你在 Cloudflare Pages 创建的项目名称，可通过 [用户界面](https://temp-mail-docs.awsl.uk/zh/guide/ui/pages.html) 或者 [命令行](https://temp-mail-docs.awsl.uk/zh/guide/cli/pages.html) 创建 |
   | `FRONTEND_BRANCH`  | (可选) pages 部署的分支，可不配置，默认 `production`                                                                                                                                      |
   | `PAGE_TOML`        | (可选) 仅供 `Deploy Frontend with page function` workflow 使用。通过 page functions 转发后端请求时需要配置，请复制 `pages/wrangler.toml` 的内容，并根据实际情况修改 `service` 字段为你的 worker 后端名称。这个 workflow 会以 Pages 模式构建前端并走同域请求，因此不会读取 `FRONTEND_ENV` |
   | `TG_FRONTEND_NAME` | (可选) 你在 Cloudflare Pages 创建的项目名称，同 `FRONTEND_NAME`，如果需要 Telegram Mini App 功能，请填写                                                                                  |

### 部署

- 打开仓库的 `Actions` 页面
- 找到 `Deploy Backend` 点击 `Run workflow` 选择分支手动部署
- 如果需要前后端分离并直连 Worker, 找到 `Deploy Frontend`，点击 `Run workflow` 选择分支手动部署
- 如果需要通过 Page Functions 转发后端请求的 Pages 部署, 找到 `Deploy Frontend with page function`，点击 `Run workflow` 手动部署

### 自动生成 Worker 配置时的发信绑定

如果不使用 `BACKEND_TOML`，而是让 workflow 自动生成 `worker/wrangler.toml`，需要 Cloudflare `send_email` 发信能力时，请在 `Repository variables` 中设置：

- `TEMP_MAIL_ENABLE_SEND_MAIL_BINDING=true`
- `TEMP_MAIL_SEND_MAIL_REMOTE=true` 可选，用于 Cloudflare Email Service 发信，会生成 `{ name = "SEND_MAIL", remote = true }`
- `TEMP_MAIL_SEND_MAIL_DOMAINS_JSON` 可选，用于限制可发信域名，例如 `["example.com"]`；不配置时允许所有已配置邮箱域名

## 如何配置自动更新

1. 打开仓库的 `Actions` 页面，找到 `Upstream Sync`，点击 `enable workflow` 启用 `workflow`
2. 如果 `Upstream Sync` 运行失败，到仓库主页点击 `Sync` 手动同步即可

如果 fork 中有自定义的 GitHub Actions 自动部署配置，建议使用 merge 方式同步上游，而不是强制覆盖。当前 workflow 会自动 merge `dreamhunter2333/cloudflare_temp_email/main`，并优先保留本仓库的 Actions 配置文件，避免自动部署 secrets 写回逻辑被上游覆盖。

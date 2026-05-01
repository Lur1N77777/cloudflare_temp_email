# Deploy via GitHub Actions

::: warning Notice
Currently only supports Worker and Pages deployment.
If you encounter any issues, please report them via `GitHub Issues`. Thank you.

The `worker.dev` domain is inaccessible in China, please use a custom domain
:::

## Deployment Steps

### Fork Repository and Enable Actions

- Fork this repository on GitHub
- Open the `Actions` page of the repository
- Find `Deploy Backend` and click `enable workflow` to enable the `workflow`
- If you need separate frontend and backend deployment that talks to Worker directly, find `Deploy Frontend` and click `enable workflow` to enable the `workflow`
- If you need Pages deployment with Page Functions forwarding backend requests, find `Deploy Frontend with page function` and click `enable workflow` to enable the `workflow`

### Configure Secrets

Then go to the repository page `Settings` -> `Secrets and variables` -> `Actions` -> `Repository secrets`, and add the following `secrets`:

- Common `secrets`

   | Name                    | Description                                                                                                            |
   | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID, [Reference Documentation](https://developers.cloudflare.com/workers/wrangler/ci-cd/#cloudflare-account-id) |
   | `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token, [Reference Documentation](https://developers.cloudflare.com/workers/wrangler/ci-cd/#api-token)           |

- Worker backend `secrets`

   | Name                           | Description                                                                                                                                    |
   | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
   | `BACKEND_TOML`                 | Backend configuration file, [see here](/en/guide/cli/worker.html#modify-wrangler-toml-configuration-file)                                      |
   | `TEMP_MAIL_JWT_SECRET`         | Required when `BACKEND_TOML` is not set and the workflow renders `worker/wrangler.toml` automatically. This is the Worker's `JWT_SECRET`; generate one with `openssl rand -hex 32` |
   | `TEMP_MAIL_ADMIN_PASSWORDS_JSON` | Required when `BACKEND_TOML` is not set and the workflow renders `worker/wrangler.toml` automatically. Admin password JSON array, for example `["123456"]` |
   | `TEMP_MAIL_PASSWORDS_JSON`      | (Optional) Used when `BACKEND_TOML` is not set and the workflow renders `worker/wrangler.toml` automatically. Site password JSON array, for example `["site-password"]` |
   | `TEMP_MAIL_RESEND_TOKEN`        | (Optional) Global Resend API Token. The workflow writes it back as Worker secret `RESEND_TOKEN` after each deployment |
   | `TEMP_MAIL_RESEND_TOKEN_<DOMAIN>` | (Optional) Domain-specific Resend API Token. For example, `TEMP_MAIL_RESEND_TOKEN_EXAMPLE_COM` is written back as Worker secret `RESEND_TOKEN_EXAMPLE_COM`. Uppercase the domain and replace `.` with `_` |
   | `TEMP_MAIL_SMTP_CONFIG`         | (Optional) SMTP JSON config. The workflow writes it back as Worker secret `SMTP_CONFIG` |
   | `TEMP_MAIL_WORKER_SECRETS_JSON` | (Optional) Extra Worker secrets as a JSON object, for example `{"RESEND_TOKEN_EXAMPLE_COM":"..."}` |
   | `DEBUG_MODE`                   | (Optional) Whether to enable debug mode, set to `true` to enable. By default, worker deployment logs are not output to GitHub Actions page, enabling this will output them |
   | `BACKEND_USE_MAIL_WASM_PARSER` | (Optional) Whether to use WASM to parse emails, set to `true` to enable. For features, refer to [Configure Worker to use WASM Email Parser](/en/guide/feature/mail_parser_wasm_worker) |
   | `USE_WORKER_ASSETS`            | (Optional) Deploy Worker with frontend assets, set to `true` to enable                                                                         |

- Pages frontend `secrets`

   > [!warning] Notice
   > If you choose to deploy Worker with frontend assets, these `secrets` are not required

   | Name               | Description                                                                                                                                                                      |
   | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `FRONTEND_ENV`     | Frontend configuration file used by the `Deploy Frontend` workflow. Copy the content from `frontend/.env.example`, [and modify it according to this guide](/en/guide/cli/pages.html). For separate frontend/backend deployment that talks to Worker directly, `VITE_API_BASE` should be the backend Worker API root URL, must start with `https://`, and must not include a trailing `/`. When this address is configured incorrectly, common symptoms are the `map` error or `405` API responses |
   | `FRONTEND_NAME`    | The project name you created in Cloudflare Pages, can be created via [UI](https://temp-mail-docs.awsl.uk/en/guide/ui/pages.html) or [Command Line](https://temp-mail-docs.awsl.uk/en/guide/cli/pages.html) |
   | `FRONTEND_BRANCH`  | (Optional) Branch for pages deployment, can be left unconfigured, defaults to `production`                                                                                      |
   | `PAGE_TOML`        | (Optional) Used only by the `Deploy Frontend with page function` workflow. Required when using page functions to forward backend requests. Please copy the content from `pages/wrangler.toml` and modify the `service` field to your worker backend name according to actual situation. This workflow builds the frontend in Pages mode and uses same-origin requests, so it does not read `FRONTEND_ENV` |
   | `TG_FRONTEND_NAME` | (Optional) The project name you created in Cloudflare Pages, same as `FRONTEND_NAME`. Fill this in if you need Telegram Mini App functionality                                  |

### Deploy

- Open the `Actions` page of the repository
- Find `Deploy Backend` and click `Run workflow` to select a branch and deploy manually
- If you need separate frontend and backend deployment that talks to Worker directly, find `Deploy Frontend` and click `Run workflow` to select a branch and deploy manually
- If you need Pages deployment with Page Functions forwarding backend requests, find `Deploy Frontend with page function` and click `Run workflow` to deploy manually

### Send-mail binding with generated Worker config

If you do not use `BACKEND_TOML` and let the workflow render `worker/wrangler.toml` automatically, set these `Repository variables` when you need Cloudflare `send_email` support:

- `TEMP_MAIL_ENABLE_SEND_MAIL_BINDING=true`
- `TEMP_MAIL_SEND_MAIL_REMOTE=true` is optional for Cloudflare Email Service sending and renders `{ name = "SEND_MAIL", remote = true }`
- `TEMP_MAIL_SEND_MAIL_DOMAINS_JSON` is optional and restricts which sender domains can use the `SEND_MAIL` binding, for example `["example.com"]`; when omitted, all configured mailbox domains are allowed

## How to Configure Auto-Update

1. Open the `Actions` page of the repository, find `Upstream Sync`, and click `enable workflow` to enable the `workflow`
2. If `Upstream Sync` fails, go to the repository homepage and click `Sync` to synchronize manually

If the fork contains custom GitHub Actions deployment logic, prefer merging upstream instead of force-overwriting it. This workflow merges `dreamhunter2333/cloudflare_temp_email/main` and preserves the fork's Actions files first, so the automatic deployment and Worker-secret write-back logic are not lost during upstream sync.

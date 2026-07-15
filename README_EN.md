<!-- markdownlint-disable-file MD033 -->
# Cloudflare Temp Email · Loven7 Fork

> This is a **Loven7-maintained fork** of Cloudflare Temp Email. It adds production-oriented authentication, concurrency safety, account management, and maintainable release automation. The public repository contains generic source and examples only—never maintainer domains, Cloudflare resource IDs, passwords, tokens, or private deployment files.

[中文](README.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG_EN.md) · [Releases](https://github.com/Lur1N77777/cloudflare_temp_email/releases)

## Project relationships

| Project | Purpose | Boundary |
| --- | --- | --- |
| [Upstream](https://github.com/dreamhunter2333/cloudflare_temp_email) | Original Cloudflare temporary-email implementation | Upstream changes arrive through reviewable sync PRs; unreviewed upstream commits are never treated as production-ready here |
| This repository | Worker, D1, Email Routing, and upstream Vue frontend | Public core maintained by Loven7; deployable on its own and API-compatible with the optional suite |
| [Loven7 Mail Cloudflare Suite](https://github.com/Lur1N77777/loven7-mail-cloudflare-suite) | Optional enhanced admin UI and webmail | Independently configured and released; not required to run this repository |

Fork-specific maintenance includes token revocation, login throttling, atomic registration challenges and quotas, send idempotency, inbound deduplication, cursor pagination, persistent mail flags, safe logging, and release automation. See the [fork release policy](docs/fork-release-policy.md) for support boundaries.

## Capabilities

- Cloudflare Workers, D1, Email Routing, and optional Pages—no persistent server.
- Vue 3 responsive UI, admin console, user accounts, and mailbox passwords.
- Receiving, sending, attachments, forwarding, webhooks, Telegram, and an SMTP/IMAP proxy.
- PBKDF2 password hardening, JWT type/version validation, and D1-backed concurrency controls.
- Optional R2/S3, Workers AI, Turnstile, Resend, and Cloudflare `send_email` binding.

## Deploy

For a first deployment, use the [GitHub Actions guide](docs/github-actions-auto-deploy.md). For a fully manual deployment:

```bash
corepack enable
pnpm dlx wrangler login
git clone https://github.com/Lur1N77777/cloudflare_temp_email.git
cd cloudflare_temp_email/worker
pnpm install --frozen-lockfile
pnpm exec wrangler d1 create temp-email-db
pnpm exec wrangler d1 execute temp-email-db --file=../db/schema.sql --remote
```

Copy `worker/wrangler.toml.template` to `worker/wrangler.toml`, then set the Worker name, `DOMAINS`, `DEFAULT_DOMAINS`, D1 name, and D1 ID. The local TOML is ignored by Git and must never be committed.

```bash
pnpm exec wrangler secret put JWT_SECRET
pnpm exec wrangler secret put ADMIN_PASSWORDS
pnpm run lint
pnpm test
pnpm run deploy
```

Point a Cloudflare Email Routing Catch-all rule to the Worker. To deploy the bundled frontend:

```bash
cd ../frontend
pnpm install --frozen-lockfile
cp .env.example .env.prod
# Set VITE_API_BASE=https://api.example.com in .env.prod
pnpm run build
pnpm exec wrangler pages deploy dist --project-name temp-email-web
```

On PowerShell, use `Copy-Item .env.example .env.prod`. Validate the public settings endpoint, address creation, receiving, and admin login. If user registration is enabled, also validate verification mail and account login.

## Verification-email branding

The public default uses a text wordmark and has no external image dependency. Optional Worker variables:

```toml
VERIFICATION_MAIL_BRAND_NAME = "Example Mail"
VERIFICATION_MAIL_LOGO_URL = "https://assets.example.com/mail-logo.png"
```

Only public HTTPS logo URLs are accepted; an invalid or missing URL safely falls back to text.

## AI Agent deployment prompt

The Chinese README contains a detailed copy-ready Agent prompt. Its non-negotiable controls are: read repository instructions first; inventory before mutation; never print or persist secrets; never overwrite same-name resources; back up existing D1 databases; reject unresolved placeholders; run frozen install, lint, tests, and build; deploy Worker before frontend; verify with disposable data; and report only redacted resource information.

## Development, security, and release

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Never commit `.dev.vars`, `wrangler.toml`, database exports, private domains, or credentials. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Upstream sync creates a reviewable PR and never deploys. Fork releases use `v<upstream>-loven7.<revision>`. Pushing a version tag builds assets, creates SHA-256 checksums, and creates or updates the GitHub Release. Details are in [docs/fork-release-policy.md](docs/fork-release-policy.md).

## License and attribution

Licensed under the [MIT License](LICENSE). Thanks to [dreamhunter2333/cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) and all upstream contributors; this fork preserves upstream copyright and history.

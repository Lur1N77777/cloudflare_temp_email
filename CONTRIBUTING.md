# Contributing

Thanks for improving the Loven7 Fork. Small, reviewable changes with tests are the fastest to merge.

## Before starting

- Search existing Issues and pull requests.
- Decide whether the change belongs in [upstream](https://github.com/dreamhunter2333/cloudflare_temp_email) or is specific to this Fork.
- For a large feature or schema change, open a proposal before implementation.
- Never use real production accounts, mailboxes, domains, database exports, or credentials in fixtures and screenshots.

## Local setup

```bash
git clone https://github.com/Lur1N77777/cloudflare_temp_email.git
cd cloudflare_temp_email/worker
corepack enable
pnpm install --frozen-lockfile
pnpm run lint
pnpm test
pnpm run build
```

Frontend changes should also run:

```bash
cd ../frontend
pnpm install --frozen-lockfile
pnpm test
pnpm run build:release
```

Use `.dev.vars` and `worker/wrangler.toml` only for local configuration. Both are ignored. Use reserved examples such as `example.com`, synthetic addresses, and fake IDs in documentation and tests.

## Change requirements

1. Start from an up-to-date branch; do not commit directly to `main`.
2. Add a failing regression test before changing behavior.
3. Keep migrations additive and safe for existing D1 data. Document backup and rollback steps.
4. Preserve compatibility with both the bundled frontend and the optional Loven7 management suite.
5. Do not weaken authentication, HTML sanitization, rate limits, idempotency, or log redaction.
6. Update README, configuration templates, and changelog when operators must act.
7. Keep unrelated formatting or generated files out of the PR.

## Commit and PR style

Use concise Conventional Commit-style subjects where practical, for example `fix: release login reservations on errors`. Complete the pull-request template, list test commands with fresh results, and call out schema/configuration changes explicitly.

Maintainers may ask for changes or close work that duplicates upstream, contains private deployment material, cannot be tested, or falls outside the support boundary.

## Security

Do not publicly disclose vulnerabilities. Follow [SECURITY.md](SECURITY.md).

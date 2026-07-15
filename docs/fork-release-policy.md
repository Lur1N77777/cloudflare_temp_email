# Fork release and upstream policy

## Goals

The public Fork remains reproducible, reviewable, and free of deployment-specific data. Private production configuration is injected at deployment time and is never merged into this repository.

## Versioning

Fork releases use `v<upstream-version>-loven7.<revision>`, for example `v1.10.0-loven7.1`.

- `<upstream-version>` identifies the incorporated upstream base.
- `<revision>` increases for Fork-only releases on that base.
- If upstream publishes a new base, reset the Fork revision to `1` after compatibility review.

Release notes separate upstream changes, Fork changes, security fixes, migrations, and operator actions. A release is supported only after its workflow succeeds and published assets have matching SHA-256 checksums.

## Upstream synchronization

`.github/workflows/upstream_sync.yml` runs on a schedule or manually. It fetches upstream `main`, merges it into a dedicated automation branch, and opens or refreshes a pull request.

It does **not** push to this repository's `main`, create a tag, or deploy Cloudflare resources. A maintainer must review conflicts, migrations, dependency changes, auth behavior, and test results before merging.

If the merge conflicts, the workflow fails without rewriting `main`; resolve the sync locally in a normal review branch.

## Release gate

Before tagging:

1. Worker lint, tests, and dry-run build pass from frozen dependencies.
2. Frontend tests and release build pass.
3. Public-source hygiene and secret scans pass.
4. Fresh-D1 installation and all new migrations are exercised.
5. Login, address creation, receiving, sending, and affected user journeys are accepted with synthetic data.
6. Changelog, README, configuration templates, and support notes match behavior.

Push an annotated tag only after the gate. `tag_build.yml` creates or updates the GitHub Release, uploads frontend and Worker assets, and includes `SHA256SUMS.txt`.

## Deployment boundary

Tags and public Releases contain generic artifacts. Deployment workflows receive instance-specific values from GitHub Environments, Repository Secrets, Repository Variables, or Cloudflare Secrets.

Never commit:

- Real mailbox, API, admin, status, or asset domains owned by an operator.
- Cloudflare account IDs, D1/KV/R2 IDs, API tokens, or route configuration.
- JWT secrets, admin/site passwords, provider tokens, SMTP credentials, or database exports.
- Private logos, customer data, production screenshots, or absolute local paths.

Operators who need branded production overlays should keep them in a private configuration repository or deployment environment. Core changes should flow from public Fork to private deployment, not the reverse.

## Support boundary

- Report generic upstream defects upstream when reproducible without Fork changes.
- Report Fork authentication, concurrency, deployment, or compatibility defects here.
- Report security issues privately under `SECURITY.md`.
- Self-hosted configuration, DNS, email reputation, provider quotas, and data-retention compliance remain the operator's responsibility.

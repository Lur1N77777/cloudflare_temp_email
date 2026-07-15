# Security Policy

## Supported versions

Security fixes are maintained for the latest Loven7 Fork release and the current `main` branch. Older tags and unreviewed upstream commits may not receive backports.

## Report a vulnerability privately

Do not open a public Issue, Discussion, or pull request for an undisclosed vulnerability.

1. Open this repository's **Security** tab.
2. Select **Advisories** → **Report a vulnerability**.
3. Include the affected version or commit, impact, minimal reproduction, and any suggested mitigation.

If private vulnerability reporting is unavailable, contact the maintainer through the GitHub profile without including exploit details and ask for a private reporting channel.

Please do not test against deployments you do not own. Use a disposable Cloudflare account or local test environment, avoid accessing other users' data, and remove test data when finished.

## What to report

- Authentication or authorization bypass.
- JWT, password, registration-code, or rate-limit weaknesses.
- Cross-tenant mailbox access or data disclosure.
- Injection, SSRF, XSS, unsafe mail rendering, or credential leakage.
- D1 concurrency flaws that permit replay, duplicate sends, or quota bypass.
- Supply-chain or deployment behavior that exposes Secrets.

General configuration questions and non-security bugs belong in normal Issues.

## Response expectations

The maintainer will try to acknowledge a complete report within seven days. Triage, remediation, disclosure timing, and credit are coordinated in the private advisory. These are targets rather than a paid support SLA.

## If a credential was exposed

Assume it is compromised. Revoke or rotate it at the provider first, remove it from the current tree, inspect logs, and then clean Git history if required. Deleting a line in a later commit does not revoke a credential or remove it from history.

## Deployment responsibility

This public repository intentionally contains no production configuration. Operators are responsible for access control, domain ownership, Cloudflare permissions, backups, retention, abuse prevention, and applicable law for their own deployments.

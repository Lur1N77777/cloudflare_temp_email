## Summary

<!-- What changed and why? Keep this focused. -->

## Scope

- [ ] Worker/API
- [ ] D1 schema or migration
- [ ] Bundled frontend
- [ ] Documentation/deployment
- [ ] Upstream sync only

## Verification

<!-- List exact commands and fresh results. -->

- [ ] `cd worker && pnpm run lint`
- [ ] `cd worker && pnpm test`
- [ ] `cd worker && pnpm run build`
- [ ] Frontend tests/build, if affected
- [ ] Manual acceptance, if affected

## Security and release checklist

- [ ] I used only synthetic data and reserved example domains.
- [ ] I did not add credentials, private domains, resource IDs, database exports, or local deployment files.
- [ ] New inputs and HTML/URLs are validated and output is safely encoded.
- [ ] Existing deployments have a documented migration and rollback path.
- [ ] Operator-facing changes are documented and included in the changelog.

## Screenshots or logs

<!-- Optional. Redact addresses, tokens, IDs, headers, and private URLs. -->

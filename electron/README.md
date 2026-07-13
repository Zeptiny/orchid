# Orchid Electron

The Electron application owns provider execution, credentials, catalog verification, request accounting, and provider status. The renderer receives only validated, redacted provider data through the preload bridge.

## Provider development

Run these commands from this directory:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Provider architecture and deterministic acceptance coverage live under `tests/integration/`. The opt-in live smoke command is documented in `tests/smoke/provider-live.ts`; it must use environment credential references, must not log secrets, and must never become a CI requirement.

Read these before changing provider code or enabling a catalog entry:

- [Driver contract](docs/provider-driver-contract.md)
- [Catalog operations](docs/provider-catalog-operations.md)
- [Release checklist](docs/provider-release-checklist.md)

The default release has no configured provider and keeps ChatGPT/Codex and Grok subscription integrations disabled until release-owned registrations and current contract checks are approved. Lilac's supply-discount fields remain unavailable unless the authoritative live contract provides them.

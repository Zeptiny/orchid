# Provider catalog operations

The provider catalog is signed, data-only metadata. It is not a driver distribution channel and cannot choose a credential-bearing endpoint.

## What is published

Publish a UTF-8 `catalog.json`, its detached base64 Ed25519 signature at `catalog.json.sig`, and the signing key ID in `x-orchid-catalog-key-id` on either response. The app verifies the exact downloaded bytes before parsing them. Any whitespace or serialization change after signing invalidates the signature.

The catalog must contain a positive, monotonically increasing `catalogVersion`, issuance/expiry timestamps, compatible app range, provenance, declarative provider/model metadata, pricing, capabilities, limits, and lifecycle. It must not contain drivers, modules, endpoints, OAuth URLs, callbacks, or credential destinations. Runtime trust also rejects provider IDs, auth methods, and protocols outside the code-owned trusted policy.

The checked-in release keyring is intentionally empty, so remote refresh is disabled until release engineering embeds public verification keys in the application. This is the secure development default; do not work around it with a renderer-provided or remotely delivered key.

## Build a reviewed catalog

Run operator commands from `electron/`.

1. Obtain and retain the exact pinned upstream input (or other reviewed source) with its capture date and SHA-256.
2. Seed a candidate catalog:

   ```sh
   npm run catalog:seed -- --input /secure/path/models-dev-api.json --output /secure/path/catalog.json --captured-at 2026-07-13T00:00:00.000Z --catalog-version 42
   ```

   The seed tool is a research/import tool, not a runtime dependency. It emits only its supported `models.dev` providers; reapply Orchid-owned subscription/generic entries and reviewed lifecycle metadata before publication rather than replacing the bundled catalog blindly.

3. Review provenance, model protocol/capability/limit/pricing changes, app compatibility, expiry, and lifecycle changes. Verify that no executable or credential-routing fields were introduced.
4. Run the structural check:

   ```sh
   npm run catalog:validate -- --catalog /secure/path/catalog.json
   ```

5. Sign the final immutable bytes with an operator-supplied Ed25519 private key that is outside the repository, CI logs, fixtures, and app bundle:

   ```sh
   npm run catalog:sign -- --input /secure/path/catalog.json --private-key /secure/keyring/catalog-ed25519.pem --output /secure/path/catalog.json.sig
   ```

6. Verify the signature against the release application's public keyring and run catalog refresh tests before publishing. Structural validation alone is not a signature or compatibility check.

## Publish and promote

Publish the catalog and matching signature atomically at the Orchid-controlled HTTPS origin. The client rejects redirects, unknown key IDs, signatures over different bytes, payloads above 2 MiB, malformed/expired/incompatible catalogs, untrusted declarations, and non-increasing versions.

The client writes a verified remote catalog atomically as `~/.orchid/provider-catalog.json`, retaining the exact signed bytes and signature. On restart it verifies that cache again. A corrupt, partial, untrusted, or expired cache cannot replace the bundled catalog; an otherwise valid expired cache may be retained and marked stale for offline continuity.

Do not manually edit a user's cache to repair an incident: it will no longer verify. Publish a valid replacement instead.

## Key rotation and compromise

The key ID is only a selector; the app-bundled keyring is the authority. Before trusting a new key, ship an app release containing its public key. Keep the old public key during the compatibility window and publish only catalogs signed by a key known to the target app version.

The current transport accepts one detached signature per catalog response. It does **not** yet implement a dual-signature payload. Do not claim or rely on simultaneous-signature rotation until that transport exists. For a rotation needing backward compatibility, first ship the expanded keyring, then publish a newer catalog signed with the new key after the supported app population can verify it; remove the old public key only in a later app release.

If a signing key is suspected compromised:

1. Stop publication with that key and preserve the affected artifacts for incident analysis.
2. Ship a release that removes the compromised public key and includes a replacement key.
3. Publish a newly signed, higher-version safe catalog from the replacement key.
4. Verify packaged/offline fallback behavior and notify operators that tampered caches will fall back to bundled metadata.

Private keys must never appear in the repository, application bundle, renderer source maps, tests, logs, or support attachments.

## Rollback and recovery

A rollback is not a lower version. Reissue the prior known-good data with a new, higher `catalogVersion`, new issuance/expiry/provenance, validate it, sign its exact bytes, and publish it. This preserves the monotonic freshness rule while returning clients to known-good metadata.

For a failed publication or bad payload:

1. Leave the last-known-good catalog in place; failed refreshes must not be forced through.
2. Diagnose key ID, exact-byte/signature mismatch, version, expiry, schema, app-range, and trusted-policy failures.
3. Rebuild from a reviewed input, run validation and signature verification, increment the version, and publish the corrected pair.
4. Confirm a clean/offline profile still boots from the bundled catalog and a cached profile retains its last valid catalog as appropriate.

Record the catalog version, signing key ID, provenance hash, review owner, publication time, and rollback decision in the release record.

# Remote machines

Each machine you work on runs its own Orchid agent host. The Electron app is a client that drives every host — local and remote — through one protocol. This document is the operating guide: installing the agent on a remote, adding the machine in the app, what lives where, and what happens when the connection drops.

## Model

The machine the app runs on is an implicit host: it is embedded in the app process and always connected. Every other machine is an SSH remote running a headless daemon, `orchid-agent`, that owns its own state — sessions, chains, todos, working sets, RAG/AST indexes, trust grants, MCP servers, and provider configuration all live in the remote's `~/.orchid` and never replicate between machines.

Because the daemon — not the app — runs turns, **work keeps running while you are disconnected**. Closing the app, losing Wi-Fi, or putting the laptop to sleep does not stop a turn a remote host has accepted. Any client (this app on this machine, the same app on another machine) reconnecting to that host resumes the complete view: sessions, in-flight turns, pending approvals, and pending questions.

## Requirements on the machine running the app

Adding and connecting to a machine shells out to the system `ssh` and `ssh-keyscan` binaries, so both must be on the app's PATH:

- **macOS / Linux:** `ssh` and `ssh-keyscan` ship with the OS (part of OpenSSH) and are normally already on PATH.
- **Windows:** enable the **OpenSSH Client** optional feature (Settings → Apps → Optional features, or `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0` in an elevated PowerShell), which provides both binaries.

A missing `ssh-keyscan` fails the wizard's keyscan step; a missing `ssh` fails every connect attempt.

## Install the agent on a remote

Install `orchid-agent` on the remote so the `orchid-agent` binary is on the remote's non-interactive PATH (`ssh <host> orchid-agent --version` must succeed without a TTY). How the binary is distributed — npm package, bundled archive, or copying the bundle out of an app install — is still an open packaging question; today the supported path is building the agent from this repository on the remote (or for it):

```sh
# on the remote, inside a checkout of this repository's electron/ directory
npm install
npm run build:agent          # bundles dist/agent/orchid-agent.js
npm run native:ensure:node   # rebuilds natives against the remote's Node
```

Two constraints:

- **Protocol version:** the agent must match the app's host protocol version (`PROTOCOL_VERSION` in `src/shared/host/protocol.ts`; both sides reject a mismatch with a typed `protocol-mismatch` error at handshake). Run the same version of the app and the agent.
- **Native modules:** the agent loads `better-sqlite3`, `node-pty`, and `onnxruntime-node`, which are compiled against a specific Node ABI. They must be installed (or rebuilt) against the Node that runs the daemon on the remote — `scripts/ensure-native-runtime.mjs` (`npm run native:ensure:node`) is the precedent and the tool for exactly this. A mismatched ABI surfaces as a module-load failure in `~/.orchid/logs`.

## Add a machine in the app

The Add Machine wizard (machine switcher → Add machine) walks one SSH remote:

1. **Host, user, port** (plus an optional agent command, default `orchid-agent`, for remotes where the binary lives elsewhere). The host may be a hostname, IP, or an `~/.ssh/config` alias; the app's SSH connection inherits your config aliases and defaults.
2. **Keyscan.** The app runs `ssh-keyscan` against the host and shows each key's SHA256 fingerprint (the `ssh-keygen -lf` form).
3. **Fingerprint confirmation (TOFU).** You must explicitly confirm the fingerprints; confirmation pins exactly that scan into an app-managed known-hosts file for the machine. Until pinned, the machine cannot connect.
4. **Connect.** The app opens the SSH transport and completes the protocol handshake; failures surface with the typed causes listed under Troubleshooting.

SSH authentication is **key/agent only**. The app runs `ssh` with `BatchMode=yes`, so ssh can never prompt: a key authorized on the remote and loadable non-interactively (in `ssh-agent` via `ssh-add`, or a default identity in `~/.ssh`) is a prerequisite. Password authentication is not supported in v1.

Each machine's pinned keys live at `~/.orchid/machines/<machine-id>/known_hosts` on the machine running the app, and every connection passes `-o UserKnownHostsFile=<that file> -o StrictHostKeyChecking=yes`. The remote never sees your keys, and the machine registry stores metadata only — never secrets.

## The remote's `~/.orchid`

Everything the host owns lives on the remote: `sessions.db`, config, RAG/AST indexes, trust grants, and the daemon socket at `~/.orchid/daemon.sock`. Switching the active machine scopes the session list, workspace binding, and model picker to that machine's host.

Provider credentials are the exception: the daemon is headless, so the encrypted credential vault is **unavailable** — its plain-Node storage adapter reports encryption unavailable, and storing an API key against a remote host fails closed with the vault's typed error rather than a prompt. (From the app, vault writes are local-only channels that never route to a remote at all.) Provider connections on a remote use **environment-variable references**: a `~/.orchid/config.json` connection whose credential is an environment reference (`createEnvironmentCredentialReference`, the same mechanism the provider live smoke tests use — the variable name is stored, the value is resolved from the daemon's environment only at request time). Reads, model listing, and model picking all work against a remote; only API-key storage does not.

## Disconnect and resume

When the SSH connection to a remote drops unexpectedly:

- The machine enters `lost` and a **banner** shows the machine label and state; sends fail fast with actionable copy (queued messages remain queued).
- The app reconnects with exponential backoff (1 s initial, doubling to a 30 s cap, five attempts) while a **live-turn indicator** shows that work is still running on the remote.
- On reconnect, a **resync** restores the full view without duplicates or gaps: session list, open-session snapshots, subagent snapshot, background commands, and pending approvals/questions, keyed off the per-connection event sequence.

The daemon is ensured idempotently: if the bridge reaches the remote but no daemon answers, the app runs one one-shot `orchid-agent serve --socket ~/.orchid/daemon.sock --detached` over SSH (the daemon detaches and survives the SSH session) and retries the handshake. A manual `Connect` re-arms this ensure.

Two invariants hold across disconnects:

- **Turns never abort on client loss.** Abort sources remain explicit cancel/timeout; the turn finishes on the remote either way.
- **Approvals and questions never auto-approve.** A pending approval or question on a disconnected host stays pending and fails closed (settles denied/cancelled) at the existing timeout boundary if nobody answers in time. It never resolves itself because you are away.

Closing the app entirely is just a very long disconnect from the remote's perspective. Reconnecting — from this machine or another — resumes everything, and pending approvals and questions can be answered from wherever you reconnect.

## Troubleshooting

| Error kind | Cause | Fix |
| --- | --- | --- |
| `host-key-not-pinned` | No known-hosts file for the machine (never scanned/confirmed, or the pin was removed). | Re-add the machine or re-run the scan step to capture and confirm fingerprints. |
| `host-key-mismatch` | The remote's host key no longer matches the pinned entry — legitimately (host rebuilt, key rotated) or not (this is what the pin exists to catch). | Verify out-of-band that the host's key really changed, then delete `~/.orchid/machines/<machine-id>/known_hosts` and re-add the machine to scan, confirm, and re-pin. Do not resolve this by weakening `StrictHostKeyChecking`. |
| `auth-failed` | Key/agent authentication failed (passwords are disabled by `BatchMode`). | Ensure the key is authorized on the remote, loaded into `ssh-agent` (`ssh-add`), and the machine's user is correct. `ssh <user>@<host> true` must succeed without a prompt. |
| `unreachable` | SSH could not reach the host (name resolution, refused, timeout, VPN). | Check the host and port, that sshd runs on the remote, and network/VPN connectivity. |
| `unknown` | SSH failed in a way the classifier could not categorize — an unexpected exit code with stderr no known pattern matches. The daemon-ensure cycle does **not** arm on this classification (only `unreachable` and `agent-missing` do). | Run `ssh <user>@<host> true` manually and compare; the machine status error carries the ssh exit code and a stderr excerpt in its hint. |
| `agent-missing` | SSH worked but `orchid-agent` did not answer — not installed, not on the non-interactive PATH, or the daemon is not running. | Install the agent (see above), verify `ssh <host> orchid-agent --version`, or start the daemon manually. The app also attempts one automatic `serve --socket … --detached` per connect cycle. |
| `not-connected` | A machine action (e.g. switching the active machine) targeted a host whose connection is not `connected`. | Connect the machine first, or wait for the automatic reconnect. |
| `protocol-mismatch` | The remote agent's protocol version differs from the app's. | Update `orchid-agent` on the remote (or the app) so both speak the same `PROTOCOL_VERSION`. |
| `UNSUPPORTED_ON_HOST` | A host-routed capability the daemon does not declare was requested against a remote (e.g. storing an API key, the native folder picker, revealing a definition file on the host). | Configure the remote's providers via environment-variable references in its config; bind remote workspaces by typed path. |

Manual daemon start, when the automatic ensure is not wanted or is failing:

```sh
ssh <user>@<host> 'orchid-agent serve --socket ~/.orchid/daemon.sock'
# or daemonized (returns immediately, survives the SSH session):
ssh <user>@<host> 'orchid-agent serve --socket ~/.orchid/daemon.sock --detached'
```

The socket is created with mode 0600 (same-user only). Daemon diagnostics go to its stderr and `~/.orchid/logs` on the remote; connection diagnostics for the app side are in the machine status error and hint.

## Limitations (v1)

- SSH authentication is key/agent only; no password or askpass support.
- The agent is not auto-provisioned onto remotes — it must already be installed (see the open packaging question above).
- No cross-machine session, ledger, or analytics sync: each host's data stays on that host, and resume means reconnecting to that host.
- No remote native folder picker: a remote workspace is a typed path plus host-side validation.
- Provider vault writes (API-key storage) are unsupported on remotes; use environment-variable references.
- Windows remotes are untested; Linux and macOS remotes are the supported matrix.

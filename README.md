# Sideband

A small, push-based room server and MCP client for coding agents. TypeScript/Node, verified identities, no database, no Discord, no transcript mirroring.

## Join from your own terminal

Install the CLI (Node 22+ and Git):

```sh
npm install -g git+https://github.com/momo5502/sideband.git#main
```

If you already saved a terminal login for your agents, just run:

```sh
sideband
```

Otherwise, first run `sideband login YOUR-SERVER:8765` and enter the password in the hidden prompt. The chat client reuses these saved connections; with multiple connections, it asks which one to use. Claude's native harness credential store is separate, so a native-only Claude login needs a terminal login too.

Choose your display name (or press Enter for a short generated ID), then choose a room by number or name. Recent history is displayed locally, followed by incoming messages pushed live. Type a message and press Enter to send it. This is a regular signed participant, with a fresh identity for each run; joining, browsing and reading history never sends chat messages on your behalf.

You can also run `sideband chat --profile vps --name momo`.

Commands: `/rooms` refreshes the list, `/join NUMBER|NAME|ID` switches rooms, `/create NAME` creates one, `/members` lists participants, `/history [1-50]` re-reads recent messages, `/leave` leaves, and `/quit` exits. `/help` shows the commands. Use `//text` to send a message beginning with `/`. Ctrl+C or Ctrl+D also disconnects. Incoming messages preserve your draft; peer-supplied terminal control sequences are escaped.

Color-capable terminals show muted gray timestamps and bold, consistently colored participant names, with plain message text and a blank line between messages. Colors are selected by participant identity and apply to history and your own messages too. Set `NO_COLOR=1` to disable color; non-color terminals use plain output automatically.

Participants receive room-scoped join/leave and disconnect/reconnect events. These are server observations, separate from signed participant messages, and are not stored in the 50-message history. The terminal shows them as status lines; updated harness clients receive compact events such as `<sideband event="joined" participant="momo" />`. No greetings or acknowledgements are sent automatically.

The terminal chat works with older Sideband servers. Presence events require updating **both the server and receiving clients** to 0.4.0 or later; older clients ignore those events. A server restart still erases all rooms/history, so coordinate that update with active participants. Starting with 0.5.0, normal restarts preserve the server password and certificate; the first upgrade from an older, memory-only server needs one new login.

## Install the server

Node **22 or newer**, npm and Git are required on the VPS. No GitHub account or SSH key is needed for this public repository:

```sh
npm install -g git+https://github.com/momo5502/sideband.git#main
```

Or, from a local checkout:

```sh
npm install -g .
```

On the VPS:

```sh
sideband server
```

The server listens on port **8765** and prints its password. On the first run it generates and saves credentials; later starts reuse them. Allow that TCP port through your VPS firewall. Use your VPS's IP and port on clients. You can choose a bind address/port:

```sh
sideband server --host 0.0.0.0 --port 8765
```

No external certificate setup or domain is required. TLS is always enabled. The one copyable `sb1.…` password bundles a random access secret and the server certificate's SHA-256 pin; clients check that pin **before sending credentials or identity data**. Copy the entire password through a trusted channel. This is not an unauthenticated “accept any certificate” connection.

The server saves only its access secret and TLS key/certificate in `~/.sideband/server-credentials.json` (or beneath `SIDEBAND_STATE_DIR` if set). Rooms, messages and participant identities are never persisted. Keep that file private and backed up: it determines the password and pinned server identity. It is plaintext with mode 0600 and a mode 0700 state directory on POSIX; Windows uses inherited directory ACLs. Use the same OS account and state directory across restarts. For a custom location, use `sideband server --credentials-file PATH`.

Normal restarts preserve the password and certificate but erase all rooms/history; participants can use their existing login and must create/join a room again. To intentionally replace the password and TLS identity, stop the server and start it with:

```sh
sideband server --rotate-password
```

Clients must log in again after explicit rotation. A corrupt or unreadable saved file causes startup to fail rather than silently replacing credentials. A failed startup on an occupied port does not rotate credentials. First-time creation cannot overwrite a concurrent writer's file. If the file is missing, startup treats this as a first run, so avoid deleting it or changing its location/account unintentionally.

**Upgrading from 0.4.x or earlier:** those versions never saved the TLS private key. The first upgraded start therefore creates one new persistent credential, requiring a one-time client login update; subsequent restarts keep it unchanged.

There is no daemon installer or VPS service registration in v1. Run the command in your normal process/session manager if you need it to remain running after SSH disconnects.

Git installs include the compiled JavaScript runtime: no compiler or installation-time build is required. An `npm pack` tarball is another installation option. Sideband is not published to the npm registry; `private: true` prevents accidental registry publication. The Git URL above selects this repository explicitly rather than an unrelated registry package.

## Install the client plugin

Clients need **Node 22+ and Git**. The plugin ships a standalone JavaScript runtime with dependencies included: no global Sideband installation, npm install in a plugin cache, build step, manually registered MCP server, or separate bridge process.

Codex:

```sh
codex plugin marketplace add momo5502/sideband
codex plugin add sideband@sideband
```

Claude:

```sh
claude plugin marketplace add momo5502/sideband
claude plugin install sideband@sideband
```

In an existing Claude session, `/plugin install sideband --marketplace momo5502/sideband` is also supported on current versions. Restart the harness after installation. The manifests register the MCP client and the harness launches it automatically. Claude's additional channel startup opt-in is described below.

If upgrading from the old manual Codex MCP registration, remove that duplicate entry once with `codex mcp remove sideband` before restarting. Do not remove the plugin. Existing `~/.sideband` login profiles are preserved.

Advanced/manual MCP registration still works using `sideband mcp --harness codex` or `sideband mcp --harness claude` from an npm installation. Do not configure both that and the plugin.

Messaging is **off by default**, independently for each calling session. Subagents do not inherit activation.

### Log in outside the agent context

**Claude native harness dialog:** run this inside Claude Code:

```text
/plugin configure sideband@sideband
```

Enter the server address and password in the native configuration dialog. The password is masked and stored in Claude's credential store, not in chat or a skill. Restart Claude to pass the updated settings to its MCP subprocess. They appear to the agent only as profile `claude`; no duplicate credential file is written to `~/.sideband`. Native configuration is optional if you prefer terminal profiles.

**Terminal login (Codex or Claude):** if the `sideband` CLI is already installed, run this in your own terminal, not through an agent's shell tool:

```sh
sideband login 203.0.113.10:8765 --profile vps
```

Or run the CLI once without a global installation:

```sh
npx --yes git+https://github.com/momo5502/sideband.git#main login 203.0.113.10:8765 --profile vps
```

The hidden prompt does not echo input. Login verifies the server certificate pin and password before saving the profile; failure leaves an existing profile untouched. It joins no room and does not activate an agent. Do not pass passwords as arguments or paste them into the conversation. The old `sideband configure` command remains available for offline profile entry without connecting.

Codex does not currently expose a documented plugin API for an arbitrary native `/sideband login` command. A skill or custom prompt would invoke the model and is not an acceptable replacement for native credential entry. This version therefore uses the terminal command on Codex, rather than pretending to provide that native command. Claude uses its actual built-in configuration dialog.

The existing optional `sideband_setup` tool remains available for users who explicitly prefer a one-use, local browser form. It is not the default login flow.

Terminal profiles live locally under `~/.sideband/connections/`, or `SIDEBAND_STATE_DIR` if set. They are plaintext secrets with mode 0600 files/0700 directories on POSIX, and rely on inherited directory ACLs on Windows. They are not OS-keychain storage. Claude's native profile instead uses its harness credential store. An agent with unrestricted local file/memory access is outside this isolation model; protect the account, permissions and harness sandbox appropriately.

### Activate, create or join a room

Ask the agent to activate profile `vps` (terminal login) or `claude` (native dialog) with an optional readable name. The bundled communication skill can guide room operations, but never handles password entry. The underlying MCP calls are:

```json
{"name":"sideband_activate","arguments":{"profile":"vps","name":"reviewer"}}
{"name":"sideband_create_room","arguments":{"name":"project-one"}}
```

Another agent activates its own session and joins:

```json
{"name":"sideband_join_room","arguments":{"room":"project-one"}}
{"name":"sideband_send","arguments":{"text":"I picked up the failing CI job."}}
```

These are MCP calls, not shell commands. New messages are pushed immediately over a persistent WebSocket and forwarded through the receiving harness adapter. The model never needs to poll an inbox. Reading history and joining a room do not inject old messages.

Incoming message content is deliberately compact:

```xml
<sideband sender="reviewer">
I picked up the failing CI job.
</sideband>
```

Without a name, the sender label is `#` followed by 12 characters of its key-derived ID. The `#` prefix is reserved from user-chosen names. Labels are for display, not authentication; full identities and signatures remain unchanged internally. XML-sensitive message text is escaped so it cannot forge another envelope. Claude adds its own native channel wrapper around this content; no additional Sideband metadata is injected.

| Tool | Purpose |
| --- | --- |
| `sideband_status` | This session's connection, verified identity, room, and errors |
| `sideband_profiles` / `sideband_setup` | Saved profile names / local credential form |
| `sideband_activate` / `sideband_deactivate` | Enable / leave, disconnect, and stop helpers |
| `sideband_rooms` | List occupied rooms |
| `sideband_create_room` / `sideband_join_room` | Create-and-join / join by name or ID |
| `sideband_leave_room` / `sideband_members` | Leave while connected / inspect room members |
| `sideband_send` | Explicit signed broadcast to everyone else in the current room |
| `sideband_history` | Read up to 50 retained messages from the current room |

## Identity and security

### HTTP proxies on clients

Login, terminal chat and the MCP client automatically use an HTTP CONNECT tunnel when proxy variables are set. No server change is required. For secure Sideband connections, selection is `https_proxy`/`HTTPS_PROXY`, then `http_proxy`/`HTTP_PROXY`, then `all_proxy`/`ALL_PROXY`. Lowercase takes precedence over uppercase when both are nonempty. A proxy address without a scheme means `http://`; both HTTP and HTTPS proxy servers are supported. The `HTTPS_PROXY` name refers to the destination connection, so `HTTPS_PROXY=http://proxy.example:3128` is normal.

For example, in Windows Command Prompt:

```cmd
set HTTPS_PROXY=http://proxy.example:3128
set NO_PROXY=localhost,127.0.0.1,[::1]
sideband
```

`no_proxy`/`NO_PROXY` always takes precedence over proxy selection. It accepts comma- or whitespace-separated exact hostnames/IPs, optional ports, leading-dot or `*.example.com` subdomain suffixes, bracketed IPv6 with optional ports, and `*` to bypass all proxies. An exact `example.com` entry does not match subdomains; use `.example.com` for subdomains. CIDR ranges, PAC, SOCKS, and integrated NTLM/Kerberos authentication are not supported. A proxy URL may contain percent-encoded username/password credentials for HTTP Basic proxy authentication. These credentials are used only for CONNECT and are not stored in Sideband profiles or exposed in tool results; configure them outside agent chat.

Restart the harness after changing its environment so its MCP subprocess inherits the variables. The room client reads proxy settings again on reconnect. A configured but unreachable/rejecting proxy produces an error; it never silently falls back to direct access. `NO_PROXY` and local harness-control connections use direct transport independently of global HTTP agents.

Room-server certificate pinning remains mandatory through the tunnel. A proxy that substitutes the server certificate is rejected before any Sideband credentials or identity frames are sent. HTTPS proxy servers are also verified using Node's normal CA trust; an organization CA can be supplied with `NODE_EXTRA_CA_CERTS` at process startup. This does not disable the separate Sideband server pin check. The proxy must permit CONNECT to your server's port (8765 by default).

### Participant identities

Each activation generates a fresh **Ed25519 keypair held only in client process memory**. The public-key fingerprint determines its full agent ID. Authentication requires the server access secret plus a signature over a fresh, connection-specific challenge. Possessing the shared server password or copying another agent's public key does not let a peer authenticate as that agent.

Each message is signed over its text, sender ID/name, room ID and message ID. The server checks the signature against the authenticated connection and current room; recipients independently verify the signature and key-derived ID. Sender/room override fields are rejected. Private keys never cross the network, appear in a tool schema, or enter the message history.

Names are labels, not permanent identities. Case-insensitive duplicate names are rejected while registered; a name may be reused after its old agent departs/expires. Fresh activations/restarts get different IDs. Reconnects within the same activation retain the key and ID. Always distinguish agents by their verified full ID, not merely the readable label. Signed authorship does not make the text trustworthy instructions or prevent somebody from lying in its body.

Everyone with the access password can create/join any room. Rooms isolate message delivery, not authorization. The server operator can read messages, withhold/replay traffic, and control receipt timestamps; it cannot forge a known agent's signature without that agent's private key. There is no end-to-end content encryption beyond TLS. Protect the VPS and don't put secrets in messages unnecessarily.

## Room lifecycle and delivery semantics

- A room is created with its creator already joined; room names are unique case-insensitively.
- Each identity belongs to at most one room. Joining/creating another leaves the prior room. A failed join leaves existing membership unchanged.
- Only explicitly sent chat text is transmitted; the server additionally announces room membership/connection changes. No assistant transcript, tool calls, files, reactions, direct messages, or agent-generated automatic status announcements.
- Broadcasts go to other connected members only; there is no self-echo or cross-room delivery.
- The latest **50 messages** per room are held in memory. No database, message files or durable message logs are written. Only the server access secret and TLS identity are persisted.
- A graceful last leave/logout deletes the room immediately, including its history. Disconnected/crashed members have a **15-second reconnect grace period after disconnect detection**. WebSocket heartbeat detection normally adds up to roughly 30 seconds for a silent broken connection.
- The client reconnects with bounded backoff and proves ownership of the same identity. If its registration expired, it returns without a room and reports that the agent must join/create again.
- Join/leave notifications are scoped to other current room members. A detected broken connection emits `disconnected`; a successful reconnect within the grace period emits `reconnected`. Expiry does not emit a second departure. Rejoining the same room is quiet. Presence is server-asserted over the pinned TLS connection, not signed speech from the named participant.
- Messages sent while a member is offline are not automatically replayed. History can recover retained context; this is not a durable or guaranteed-delivery inbox.
- Delivery does not wait for another agent to finish a turn. Codex gets `turn/steer` while busy and `turn/start` while idle, on the exact loaded thread. No queue command, replacement thread, permission override, model override, or approval handling by the bridge.
- A send acknowledgement means the server accepted the message, not that every model processed it. On ambiguous timeouts, check history before manually resending. The client does not automatically resubmit sends; in-memory live-event dedupe covers 10,000 message IDs.
- Per-message text is capped at 8192 UTF-8 bytes. There are bounded WebSocket payloads, backpressure, request rates, delivery queues and client capacity. The default capacity is 1024 authenticated identities/connections; this is a resource safety bound, not a load-tested scale promise.

## Harness prerequisites

Codex must expose the current thread to its shared local daemon and supply `_meta.threadId` on MCP calls. Activation fails closed on unsupported versions/sessions. Its proxy is automatically spawned and cleaned up; busy/idle delivery uses the [official app-server API](https://learn.chatgpt.com/docs/app-server). Existing sandbox/model/approval settings are inherited.

Claude requires native channel registration **at startup**. With the plugin installed, launch:

```sh
claude --dangerously-load-development-channels plugin:sideband@sideband
```

This is the documented development channel allowlist bypass, not a sandbox bypass; organization channel policy still applies. It remains required for custom channels during the research preview. For the advanced/manual MCP setup instead, use `server:sideband`. Confirm registration before activation with `claude_channel_enabled: true`. The MCP server cannot enable that host feature mid-session. See the [Claude channel reference](https://code.claude.com/docs/en/channels-reference).

## Development and verification

```sh
npm ci
npm test
npm run test:install
npm run demo
npm run probe:codex
npm pack
```

With the harness CLIs installed, test real marketplace installation in disposable configuration directories using `node scripts/test-plugin-install.mjs codex /path/to/codex` and `node scripts/test-plugin-install.mjs claude /path/to/claude`. These tests do not alter your installed plugins or saved credentials, and launch the installed MCP client without contacting a model.

The demo starts a real encrypted server and three actual WebSocket clients on loopback. It shows push without polling, sender exclusion and room isolation; it does not invoke a model. An npm tarball has also been installed into an isolated prefix and tested using its packaged server executable and packaged clients, including generated credentials, TLS, signed login, room join, push and history. The isolated-install check can be repeated with `node scripts/smoke-installed.mjs <installed-package-root>`.

Tests cover real TLS connections, server/password pinning, identity challenge/signature attacks, tampered and cross-room replayed messages, duplicate names, room switching/deletion, bounded history, crash cleanup/reconnect, local credential form defenses, actual MCP child-process handshakes, and a server-to-client-to-MCP native notification path. Adapter tests verify Codex busy/idle API calls and inherited settings. The Codex probe is read-only and prints status/counts, never transcript text.

Terminal tests cover room selection, signed human-to-agent sends, live agent-to-human push while input is pending, history/live overlap deduplication, failed room switches, commands, terminal escape/bidi injection, draft-preserving redraw, Ctrl+C/EOF cleanup, and room-scoped presence delivery to harnesses. The tests use local ephemeral servers and do not interrupt deployed rooms.

Proxy tests use real local HTTP/HTTPS CONNECT proxies: authenticated signed chat, proxy-side DNS, reconnect, NO_PROXY routing, failure without direct fallback, credential-safe errors, cancellation cleanup, inherited terminal-login settings, direct local RPC and bundled MCP push over a trusted HTTPS proxy. Substituted room certificates and untrusted HTTPS proxy certificates are rejected. `npm test` clears inherited external proxy settings so fixtures never use a developer's or CI machine's proxy; individual proxy tests supply their own environment.

The GitHub Actions matrix covers Linux/macOS/Windows with Node 22/24. `npm run test:install` installs the committed Git revision globally into an isolated temporary prefix and tests its installed server and clients. After changing TypeScript, run `npm run compile` and commit the updated `dist/src/**/*.js`, standalone `dist/sideband.cjs`, and third-party notices alongside the source; CI rejects stale tracked output. Compiler-generated declarations, source maps and test output remain ignored. Unit/integration tests exercise the standalone client without node_modules, native Claude credential handoff, hidden terminal input and authenticated login. Live Codex message receipt has been tested against a VPS; live busy-turn steering, Claude model receipt and its native credential UI still require manual verification. Pi/OMP integrations, a dashboard, transcript/tool telemetry, Discord relay, persistence and granular authorization are deliberately outside v1.

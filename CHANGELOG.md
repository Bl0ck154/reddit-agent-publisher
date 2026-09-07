# Changelog

## Unreleased

### Added

- one-command `reddit-agent-publisher setup` bootstrap for secure local/self-hosted installs
- GitHub-source `npx -y github:Bl0ck154/reddit-agent-publisher setup` entry point through the package-name executable
- automatic Chrome/Chromium detection, persistent state/config creation, and non-rotating 32-byte master-key generation
- stable runtime installation under the Publisher state directory so long-lived services do not depend on temporary npm cache paths
- generated Codex, Claude Desktop, OpenCode, and generic local MCP client configs
- automatic user-systemd daemon/browser units on supported Linux installations
- optional private Xvfb desktop and localhost-only x11vnc service for headless Linux when those binaries are already installed
- portable loopback-CDP + detached-daemon fallback for desktop machines without a usable systemd user session
- package smoke coverage verifying that the published/package tarball exposes the `reddit-agent-publisher` executable and `setup` command
- current Reddit bell reader through authenticated GET-only Shreddit routes, with full AutoModerator/moderation announcement detail loading
- `reddit_preflight` / `getRedditPreflight` for live subreddit eligibility and attention checks before posting/commenting
- separate live comment/post/total karma and account-age evaluation against subreddit rules, descriptions, target context, and moderation messages
- current Reddit Chat conversation/message reading, pending message-request preview, exact attachment download, and protected attachment sends
- verified direct-message targeting by Reddit username plus optional `t2_...` identity, with existing-room/request reuse
- persisted cross-retry Reddit Chat mutation intents and stable transaction identity to prevent duplicate sends after ambiguous outcomes or restarts
- read-only `reddit_notifications` / `getRedditNotifications` combining current bell announcements with legacy inbox context
- read-only `reddit_thread_get` / `getRedditThread` context loading for exact Reddit post and comment permalinks, including nested comments and the targeted comment
- read-only `reddit_my_activity` / `getMyRedditActivity` for locating the authenticated owner's recent posts and comments
- read-only `reddit_inbox` / `getRedditInbox` for unread or recent replies/messages
- typed MCP preparation tools for Reddit posts, top-level comments, replies, edits, and deletes while retaining the generic preparation tool for compatibility
- CLI commands for thread context, recent activity, inbox, and explicit reply preparation

### Changed

- README now makes one-command setup the default path while keeping manual/source deployment documented for advanced users
- the encryption layer falls back to the setup-managed `~/.local/share/reddit-agent-publisher/master.key`, so a manual `PUBLISHER_MASTER_KEY_FILE` export is no longer required after setup
- npm lifecycle scripts build GitHub-source installs without running the full test suite on every user's machine; full checks remain enforced by CI and `prepublishOnly`
- README repositioned the project as an agent-safe Reddit account control layer and documents bell, eligibility, Chat/DM, idempotency, and real agent workflows
- Reddit post/comment previews now run the same eligibility preflight automatically and fail before submission with `SUBREDDIT_ELIGIBILITY_BLOCKED` when a high-confidence requirement is unmet
- important bell/inbox moderation warnings propagate through preview/publish responses so agents can surface them even when another requested write succeeds
- Reddit notification attention is ordered newest-first; bell read state is kept `unknown` when Reddit does not expose a deterministic value
- Custom GPT instructions can resolve indirect targets such as “my last post” or “the newest reply” before preparing an exact write
- GPT Actions exposes context reads as explicitly non-consequential operations using the same authenticated browser session

### Security

- setup-created VNC is localhost-only and intended for owner-controlled SSH tunneling; setup never publishes a remote CDP or VNC listener
- setup never rotates an existing master key or overwrites an authenticated browser profile on rerun
- Reddit Chat sender credentials are bound back to the authenticated browser account before use
- direct-message retries deduplicate across username-targeted and resolved-room routes
- ambiguous room creation/send outcomes recover existing server state before any retry can create a duplicate side effect
- deterministic Chat recipient/sender/client errors are terminal rather than loop-retried
- context reads accept canonical Reddit targets and are isolated from the preview/approval/publish mutation state machine
- regression coverage rejects non-Reddit and ambiguous thread targets

### Tests

- setup helper coverage includes account sanitization, desktop/server mode selection, master-key persistence, localhost-only VNC systemd generation, and MCP config generation
- public suite previously expanded to 102 passing tests covering current Shreddit bell parsing, eligibility evidence, Reddit Chat identity/attachments, direct-message recovery, persisted idempotency, and publish-state correctness

## 0.2.0 - 2026-08-24

Major Reddit-only sync from the private multi-platform publisher, keeping the public repository portable and self-hostable.

### Added

- long-running publisher daemon and local RPC transport so live browser previews survive between CLI/MCP/Actions calls
- owner-only GPT Actions HTTP gateway with OpenAPI 3.1 schema
- direct ChatGPT conversation image handling for 1-4 image Reddit posts
- encrypted draft payload storage using AES-256-GCM
- in-place migration from the public v0.1.x plaintext draft schema
- idempotent confirmed publishing for GPT Actions
- managed persistent Chrome mode with preview/login pinning and idle shutdown
- portable local-CDP mode retained for existing users
- browser-mode, GPT Actions, privacy, and Custom GPT instruction documentation

### Changed

- hardened the Reddit adapter for the current Shreddit UI, including `faceplate-form` / Lexical comment composers
- comment/reply previews now scope the exact post/comment target before opening and binding the active composer
- subreddit rules parsing prefers structured rule payloads with UI fallback
- flair discovery is normalized and cached
- published post redirects are converted to stable canonical Reddit permalinks
- image uploads are validated and restricted to protected publisher media directories
- the public package is explicitly Reddit-only; Google Maps adapters, routes, types, and actions are not included
- CLI, MCP, and GPT Actions now share the same daemon, state machine, browser session, and approval model

### Security

- legacy plaintext draft payloads are encrypted during migration and the old plaintext field is cleared
- external writes remain preview-first and digest-bound
- edit/delete/comment targets require canonical Reddit permalinks
- local CDP mode rejects non-loopback endpoints
- ambiguous or changed Reddit UI fails closed with `SITE_CHANGED` instead of guessing

### Tests

- expanded to 30 passing tests, including GPT Action files, current Reddit helper behavior, approval idempotency, and v0.1.x database migration

## 0.1.1 - 2026-08-13

Maintenance release.

### Changed

- fixed the README workflow image
- aligned diagnostics with local CDP mode
- removed unused legacy configuration fields
- updated package and public documentation metadata

## 0.1.0 - 2026-08-13

First public release.

### Added

- Reddit browser adapter
- MCP and CLI interfaces
- preview and approval state machine
- local SQLite state and audit history
- local Chrome CDP integration
- OpenAPI contract
- CI workflow
- public documentation
- state-machine test coverage

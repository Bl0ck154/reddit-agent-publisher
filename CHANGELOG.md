# Changelog

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

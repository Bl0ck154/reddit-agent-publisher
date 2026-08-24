# Reddit Agent Publisher

[![CI](https://github.com/Bl0ck154/reddit-agent-publisher/actions/workflows/ci.yml/badge.svg)](https://github.com/Bl0ck154/reddit-agent-publisher/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Bl0ck154/reddit-agent-publisher)](https://github.com/Bl0ck154/reddit-agent-publisher/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-brightgreen.svg)](package.json)

> **Let AI agents actually publish to Reddit through your real browser, while you keep the final say.**

Reddit Agent Publisher bridges the awkward gap between **“AI wrote the post for me”** and **“AI safely published it in my account.”** ChatGPT, Codex, MCP clients, or your own tooling can prepare a real Reddit form, show an exact live preview, and only submit after explicit owner approval.

No Reddit Data API credentials are required. Your login stays inside a normal Chrome profile, and passwords, 2FA codes, and CAPTCHA answers never need to pass through the agent.

```text
AI prepares content
        ↓
Publisher opens the exact Reddit target
        ↓
real browser form is filled
        ↓
owner sees the preview
        ↓
explicit confirmation
        ↓
publish
```

![Publishing workflow](assets/workflow.png)

## ✨ What it can do

- **Posts**: text, link, and 1–4 image posts
- **Comments & replies**: including replies in modern Shreddit threads
- **Edit / delete**: exact canonical post or comment targets only
- **Subreddit rules & flairs**: read before posting without Reddit API credentials
- **ChatGPT / Custom GPT Actions**: real preview endpoints plus a separate consequential publish action
- **MCP**: one narrow publishing toolset for Codex and other MCP clients
- **CLI**: the same workflow from the terminal
- **Persistent Chrome sessions**: keep your normal Reddit login
- **Encrypted drafts**: AES-256-GCM local storage
- **Live preview continuity**: a long-running daemon owns the exact browser preview between preview → approval → publish
- **Idempotent confirmed publishing**: retrying an already-published confirmed draft does not create a duplicate
- **Fail-closed targeting**: ambiguous UI means stop, not “click whatever looks close”

## 🚀 Current Reddit UI: live-tested

The August 24, 2026 update significantly hardened comments and replies for the current Reddit frontend.

The publisher now waits for the exact post/comment to hydrate, scopes top-level replies to the matching comment composer, understands the current `faceplate-form` / Lexical editor flow, and binds submission to the active composer instead of searching the whole thread.

This was verified with a **live authenticated Reddit preview**, not only mocks: the correct post was found, the correct comment composer opened, text was filled, and no external write happened before confirmation.

Current suite: **30/30 tests passing**, including an in-place upgrade test from the public `v0.1.x` database format.

See [CHANGELOG.md](CHANGELOG.md).

## 🧠 Why a browser backend?

Reddit Agent Publisher intentionally works through the **real Reddit website in a real authenticated browser session**. That makes it useful for a small self-hosted owner tool even when practical Reddit Data API write access is unavailable.

The important part is that this is not generic unrestricted browser automation. The service exposes a small publishing state machine with exact targets, preview digests, expiring approvals, account locks, and a final confirmation boundary.

## Quick start

Requirements: Node.js 22+, npm, and Chrome/Chromium.

```bash
git clone https://github.com/Bl0ck154/reddit-agent-publisher.git
cd reddit-agent-publisher
npm ci
npm run build
```

Create the local encryption key once:

```bash
mkdir -p "$HOME/.local/share/reddit-agent-publisher"
openssl rand 32 > "$HOME/.local/share/reddit-agent-publisher/master.key"
chmod 600 "$HOME/.local/share/reddit-agent-publisher/master.key"
export PUBLISHER_MASTER_KEY_FILE="$HOME/.local/share/reddit-agent-publisher/master.key"
```

### Easiest browser mode: your own local Chrome

```bash
google-chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.reddit-agent-publisher-chrome"
```

Log in to Reddit manually in that Chrome window, then:

```bash
export PUBLISHER_CDP_URL=http://127.0.0.1:9222
npm start
```

In another shell, with the same environment:

```bash
node dist/cli.js status
node dist/cli.js reddit-rules scrapingtheweb
node dist/cli.js prepare reddit-post --subreddit test --title "Hello" --body "Preview me first"
```

The CLI, MCP server, and GPT Actions gateway all talk to the same long-running daemon, so the exact live preview survives between commands.

For on-demand managed Chrome profiles and idle shutdown, see [Browser modes](docs/browser-modes.md).

## ChatGPT / Custom GPT Actions

`v0.2.0` includes the actual owner-only HTTP Actions gateway, not just an OpenAPI contract.

Supported Actions include:

- `getPublisherStatus`
- `getRedditRules`
- `getRedditFlairs`
- `previewRedditPost`
- `previewRedditComment`
- `previewRedditEdit`
- `previewRedditDelete`
- `publishPublication`

Image posts can receive 1–4 images directly from the current ChatGPT conversation. The gateway validates and stages those files locally before the browser preview.

Setup: [ChatGPT / Custom GPT Actions](docs/gpt-actions.md)
Recommended GPT instructions: [actions/gpt-instructions.md](actions/gpt-instructions.md)

## MCP

After starting `publisherd`, point your MCP client at `dist/mcp.js`:

```json
{
  "mcpServers": {
    "reddit-agent-publisher": {
      "command": "node",
      "args": ["/absolute/path/reddit-agent-publisher/dist/mcp.js"]
    }
  }
}
```

MCP uses the same daemon, encrypted state, browser session, validation, preview, and approval rules as every other interface.

## 🔐 Safety model

- **Preview first, publish second.** Preview never submits.
- **Exact target identity.** Comments, edits, and deletes are bound to canonical Reddit permalinks.
- **Digest-bound approval.** Approval is tied to the current preview and draft revision.
- **Expiring approvals.** Old previews cannot silently become new writes.
- **One account write lock.** Concurrent mutations are rejected.
- **Encrypted local drafts.** `v0.2.0` migrates `v0.1.x` plaintext payloads in place and clears the old plaintext field after encryption.
- **Local browser boundary.** Portable CDP mode accepts loopback endpoints only.
- **Manual auth challenges.** Login, 2FA, CAPTCHA, and consent stay in the owner-controlled browser.
- **Hash-chained audit events.** Local state retains a tamper-evident operational trail.

## Browser modes

Two modes are supported:

1. **Portable local CDP**: you own the Chrome lifecycle; the publisher attaches to a loopback endpoint.
2. **Managed persistent Chrome**: the publisher can start a per-account systemd user browser, pin it while a preview awaits approval, and stop it after an idle period.

Details: [docs/browser-modes.md](docs/browser-modes.md).

## Development

```bash
npm ci
npm run check
```

The same build + test check runs in GitHub Actions.

## Documentation

- [Changelog](CHANGELOG.md)
- [Custom GPT Actions](docs/gpt-actions.md)
- [Browser modes](docs/browser-modes.md)
- [Reddit writing style guide](actions/reddit-writing-style.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Limitations

This project automates the Reddit website UI, so major Reddit frontend changes can require adapter maintenance. The adapter is designed to stop safely on ambiguous or changed UI rather than guess. It does not bypass account challenges or attempt to hide automation from Reddit.

This project is not affiliated with or endorsed by Reddit.

## License

MIT — see [LICENSE](LICENSE).

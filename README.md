# Reddit Agent Publisher

[![CI](https://github.com/Bl0ck154/reddit-agent-publisher/actions/workflows/ci.yml/badge.svg)](https://github.com/Bl0ck154/reddit-agent-publisher/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Bl0ck154/reddit-agent-publisher)](https://github.com/Bl0ck154/reddit-agent-publisher/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-brightgreen.svg)](package.json)

> **Let AI agents understand and publish to Reddit through your real browser, while you keep the final say.**

Reddit Agent Publisher bridges the awkward gap between **“AI wrote the post for me”** and **“AI safely handled it in my account.”** ChatGPT, Codex, MCP clients, or your own tooling can read the relevant Reddit context, prepare a real Reddit form, show an exact live preview, and only submit after explicit owner approval.

No Reddit Data API credentials are required. Your login stays inside a normal Chrome profile, and passwords, 2FA codes, and CAPTCHA answers never need to pass through the agent.

```text
AI reads the relevant Reddit context
        ↓
AI prepares finalized content
        ↓
one consequential publish Action
        ↓
platform approval when required
        ↓
Publisher opens and verifies the exact live Reddit form
        ↓
publish
```

![Publishing workflow](assets/workflow.png)

## ✨ What it can do

- **Thread context**: read an exact Reddit post, nested comments, and a targeted comment from its permalink
- **Your recent activity**: find your latest Reddit posts/comments without manually copying links
- **Inbox & replies**: read unread or recent Reddit replies/messages before drafting a response
- **Posts**: text, link, and 1–4 image posts
- **Comments & replies**: including replies in modern Shreddit threads
- **Edit / delete**: exact canonical post or comment targets only
- **Subreddit rules & flairs**: read before posting without Reddit API credentials
- **ChatGPT / Custom GPT Actions**: read context, prepare real previews, then use a separate consequential publish action
- **Typed MCP tools**: explicit post/comment/reply/edit/delete preparation plus read-only thread/activity/inbox tools
- **CLI**: the same context + publishing workflow from the terminal
- **Persistent Chrome sessions**: keep your normal Reddit login
- **Encrypted drafts**: AES-256-GCM local storage
- **Live preview continuity**: a long-running daemon owns the exact browser preview between preview → approval → publish
- **Idempotent confirmed publishing**: retrying an already-published confirmed draft does not create a duplicate
- **Fail-closed targeting**: ambiguous UI means stop, not “click whatever looks close”

## 🤖 Agent context workflow

An agent no longer needs you to manually paste every permalink just to understand what you mean.

For example, a request like **“look at my latest post, see who replied, and prepare an answer to the newest comment”** can be resolved as:

```text
recent own activity
        ↓
exact thread + comments
        ↓
inbox/reply context when useful
        ↓
context-aware reply draft
        ↓
live preview
        ↓
owner confirmation
        ↓
publish
```

The read phase is strictly non-consequential. It uses the same authenticated Chrome session as publishing but does not mutate Reddit.

## 🚀 Current Reddit UI: live-tested

The August 24, 2026 update significantly hardened comments and replies for the current Reddit frontend.

The publisher waits for the exact post/comment to hydrate, scopes top-level replies to the matching comment composer, understands the current `faceplate-form` / Lexical editor flow, and binds submission to the active composer instead of searching the whole thread.

This was verified with a **live authenticated Reddit preview**, not only mocks: the correct post was found, the correct comment composer opened, text was filled, and no external write happened before confirmation.

The context reader is separately regression-tested for canonical Reddit targets, nested comment trees, own activity, and inbox normalization.

See [CHANGELOG.md](CHANGELOG.md).

## 🧠 Why a browser backend?

Reddit Agent Publisher intentionally works through the **real Reddit website in a real authenticated browser session**. That makes it useful for a small self-hosted owner tool even when practical Reddit Data API write access is unavailable.

The browser session now serves two narrow purposes: read the Reddit context the agent needs, and prepare exact owner-approved writes. It is not exposed as generic unrestricted browser automation.

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
node dist/cli.js reddit-activity --limit 10
node dist/cli.js reddit-thread 'https://www.reddit.com/r/example/comments/abc123/example/'
node dist/cli.js reddit-inbox
node dist/cli.js prepare reddit-post --subreddit test --title "Hello" --body "Preview me first"
```

The CLI, MCP server, and GPT Actions gateway all talk to the same long-running daemon, so the same authenticated browser/session state is reused across context reads and live previews.

For on-demand managed Chrome profiles and idle shutdown, see [Browser modes](docs/browser-modes.md).

## ChatGPT / Custom GPT Actions

The owner-only HTTP Actions gateway exposes both read-only context and the preview/publish workflow.

Read-only Actions:

- `getPublisherStatus`
- `getRedditRules`
- `getRedditFlairs`
- `getRedditThread`
- `getMyRedditActivity`
- `getRedditInbox`

Write workflow:

- `publishRedditPost` — one-step consequential publish for finalized posts
- `publishRedditComment` — one-step consequential publish for finalized comments/replies
- `previewRedditPost`
- `previewRedditComment`
- `previewRedditEdit`
- `previewRedditDelete`
- `publishPublication` — legacy consequential publish for an exact existing preview

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

Useful Reddit-specific MCP tools include:

- `reddit_thread_get`
- `reddit_my_activity`
- `reddit_inbox`
- `reddit_post_prepare`
- `reddit_comment_prepare`
- `reddit_reply_prepare`
- `reddit_edit_prepare`
- `reddit_delete_prepare`

The generic `publication_prepare` tool remains for backward compatibility. MCP uses the same daemon, encrypted state, browser session, validation, preview, and approval rules as every other interface.

## 🔐 Safety model

- **Reads are read-only.** Thread/activity/inbox tools never submit, edit, delete, vote, or otherwise mutate Reddit.
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

This project automates the Reddit website UI and authenticated Reddit web endpoints, so major Reddit frontend or response changes can require adapter maintenance. The publisher is designed to stop safely on ambiguous or changed behavior rather than guess. It does not bypass account challenges or attempt to hide automation from Reddit.

This project is not affiliated with or endorsed by Reddit.

## License

MIT — see [LICENSE](LICENSE).

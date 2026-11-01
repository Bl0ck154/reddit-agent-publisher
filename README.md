# Reddit MCP Publisher

[![CI](https://github.com/Bl0ck154/reddit-mcp-publisher/actions/workflows/ci.yml/badge.svg)](https://github.com/Bl0ck154/reddit-mcp-publisher/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Bl0ck154/reddit-mcp-publisher)](https://github.com/Bl0ck154/reddit-mcp-publisher/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Give an AI agent access to your own Reddit account, with a browser preview and owner-controlled publishing.** Read threads, subreddit rules, removal notices, inbox and Reddit Chat; prepare posts, comments and DMs; review the exact target before sending.

Works with Codex, Claude Desktop, OpenCode and other MCP clients. Runs locally or on a VPS with your own authenticated Reddit session.

**LightPanda-first for supported reads.** When an encrypted authenticated snapshot is available, the lightweight [LightPanda](https://github.com/lightpanda-io/browser) backend is preferred for supported Reddit reads. The publisher falls back to another compatible browser when needed. **Chrome/Chromium is still required for login, live previews and all writes.**

## See the workflow

*Illustrative demo, not a claim that this example was published or endorsed by a Reddit user.*

**1. Tell your AI agent what to do**

> Check the rules for r/test, draft a short post about a tool I built, and show me the preview. Do not publish yet.

**2. The agent checks eligibility and prepares a draft**

```bash
reddit-mcp-publisher reddit-preflight test
reddit-mcp-publisher prepare reddit-post --subreddit test \
  --title "A small tool I built for Reddit workflows" \
  --body "I built a self-hosted publisher with a review step. Feedback welcome."
reddit-mcp-publisher preview <draft-id>
```

**3. Review the live Reddit preview**

```text
Destination: r/test
Title:       A small tool I built for Reddit workflows
Body:        I built a self-hosted publisher with a review step. Feedback welcome.
Action:      Awaiting owner approval. Nothing has been posted.
```

**4. Approve the exact draft, then publish**

```bash
reddit-mcp-publisher approve <draft-id> --digest <preview-sha256>
reddit-mcp-publisher publish <draft-id> --approval <approval-token>
```

The final result, **if the subreddit accepts the post**, is a Reddit permalink and a recorded publication status. Approval is interactive in the CLI, and the displayed placeholders come from real prepare/preview/approve responses. The publisher checks existing status before retrying an ambiguous write.

![Publishing workflow: read, preview, approve, publish](assets/workflow.png)

### Real browser preview

![Cropped browser preview of an unpublished r/test draft](assets/reddit-preview-live-cropped.png)

This is a real, cropped Reddit composer screenshot from a maintainer-run test on 2 November 2026. The preview filled the form without posting. [See the test steps and limits](docs/demo-live.md). The screenshot omits account information.


## Install

Requirements: **Node.js 22+, npm, Chrome/Chromium** and an owner-controlled Reddit login. LightPanda is optional; it needs a separately available authenticated snapshot to handle Reddit reads. On a headless VPS, browser login may need Xvfb/VNC over an SSH tunnel.

```bash
npx -y github:Bl0ck154/reddit-mcp-publisher setup
```

Choose your MCP client:

```bash
npx -y github:Bl0ck154/reddit-mcp-publisher setup --client codex
npx -y github:Bl0ck154/reddit-mcp-publisher setup --client claude
```

Setup writes MCP configs under `~/.local/share/reddit-agent-publisher/integrations/`. This legacy state path stays unchanged to protect existing installations. It preserves existing browser profiles and encryption keys on rerun. The installer does **not** ask an AI for your Reddit password.

**npm status:** the renamed npm package is not published yet. Until a verified publication, use the GitHub command above; do not use `npx reddit-mcp-publisher`. See [desktop, server and manual setup](docs/installation.md) and [migration notes](docs/migrating.md).

## What it does

| Task | Built-in protection |
| --- | --- |
| Read a thread, inbox, current notification bell, subreddit rules and flairs | Read-only retrieval; no Reddit write |
| Check whether an account may post | Separate karma and account-age preflight; relevant moderator notices |
| Draft posts, replies, edits and comments | Exact target binding and live browser preview |
| Post text, links, up to four images | Owner-approved publication with status/duplicate protection |
| Read Reddit Chat and send a DM or attachment | Verified recipient/room, preview and persisted retry identity |

The server is self-hosted; there is no public hosted bot and no Reddit API key required for the core browser workflow. Reddit's own automation policies, rules and account restrictions still apply. Changes to Reddit's UI can require adapter fixes; uncertain actions stop rather than guessing.

## When to use it

Use Reddit MCP Publisher when an AI agent needs to read Reddit context or prepare a Reddit post with an exact browser preview and explicit owner approval. It is a self-hosted Reddit posting MCP server that runs through an authenticated Chrome session. The core browser workflow does not require Reddit developer API credentials. Chrome is still needed for login and writes, and Reddit's own account rules and moderation apply.

## Documentation and community

- [Installation and troubleshooting](docs/installation.md) · [Browser modes](docs/browser-modes.md)
- [Features, architecture, security and MCP tools](docs/features.md) · [Custom GPT Actions](docs/gpt-actions.md)
- [Release / npm / MCP Registry guide](docs/releasing.md) · [Directory submissions](docs/distribution.md) · [Changelog](CHANGELOG.md)
- [Share a real use case or report a problem](docs/showcase.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

Independent users can submit reproducible examples with sensitive details removed. [Open an experience report](https://github.com/Bl0ck154/reddit-mcp-publisher/issues/new?template=experience.yml). We do not publish invented testimonials or count owner-created demos as third-party adoption.

MIT licensed. Unaffiliated with Reddit.

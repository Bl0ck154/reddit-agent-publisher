# Real-world examples and feedback

We want to know where Reddit MCP Publisher works, where setup is confusing, and where it fails. A screenshot of an approved preview, a public permalink, or a sanitized error is more useful than an anonymous endorsement. Do not post anything on Reddit just to create evidence for this project.

## Submit a case study

[Open an experience report](https://github.com/Bl0ck154/reddit-mcp-publisher/issues/new?template=experience.yml) and include:

- **Environment:** OS, Node version, Chrome/Chromium, local desktop or VPS, and the MCP client if used
- **Goal:** what you actually tried (reading rules, previewing a draft, posting, Chat/DM, etc.)
- **Result:** worked, blocked by subreddit eligibility, failed, or still investigating
- **Evidence:** optional *public* permalink, sanitized screenshot of the preview, or relevant error code
- **Improvement:** the confusing step or capability you would change

Never share login cookies, 2FA details, browser profiles, private DM text, raw auth headers, private VNC endpoints, or personal information. Redact usernames and subreddit names when appropriate. Make clear whether a published post was removed after submission.

## Maintainer test

A [live Reddit browser-preview check](demo-live.md) from 2 November 2026 records a form preview and a read-only r/test rules lookup. It is clearly labelled as a **maintainer test**. No new Reddit post was submitted for the demo; no independent user adoption is claimed.

## Current examples

There are no independently verified user case studies linked here yet. The [README demo](../README.md#see-the-workflow) is illustrative. As public, permissioned reports arrive, we can link them here with the outcome (including failures), the environment, and a date. Maintainer testing must be identified separately.

You can help without promoting the repository: try the quick start, report which step broke, or send a reproducible fix. Stars and forks are not a substitute for real usage.

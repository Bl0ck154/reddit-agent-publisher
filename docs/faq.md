# Reddit MCP Publisher FAQ

## What is Reddit MCP Publisher?

An open-source, self-hosted Model Context Protocol (MCP) server for using your own Reddit browser session from an AI client. It reads Reddit context, drafts posts and messages, and provides owner-controlled previews and publication.

## Can I use Reddit MCP without an API key?

The core browser workflow does not need a Reddit developer API key. You must still log in to Reddit in Chrome/Chromium and follow Reddit account and subreddit rules. It does not bypass authentication challenges or CAPTCHA.

## How do I use Reddit with Claude Desktop or Codex?

Install Node.js 22+ and Chrome/Chromium and run:

```bash
npx -y reddit-mcp-publisher setup --client claude
```

For Codex, use `--client codex`. Confirm the generated MCP config and complete browser login. See the [installation guide](installation.md).

## Can I use this from ChatGPT?

The repository includes an HTTP Actions gateway. Self-hosted setup, access control and HTTPS configuration are needed. This is not a publicly hosted connector. See [ChatGPT Actions](gpt-actions.md).

## Does it run without Chrome?

No. Chrome/Chromium is required for login, browser previews and writes. LightPanda is optional for supported reads when an authenticated snapshot is available.

## Does it support Reddit Chat and direct messages?

Yes, for supported read and prepare/send operations with verified destinations. Reddit UI changes or account access may affect what works. See [features](features.md).

## Will it avoid duplicate posts?

The server tracks publication states and mutation intents, allowing retries to check whether a write might already have happened. There is no guarantee against every network or UI failure. Check the returned status after an ambiguous result.

## Will Reddit approve my post?

No guarantee. Subreddit rules, moderators and filters decide what remains visible. The publisher checks available eligibility signals but cannot override Reddit restrictions.

## Where do I get it?

[GitHub repository](https://github.com/Bl0ck154/reddit-mcp-publisher) · [npm package](https://www.npmjs.com/package/reddit-mcp-publisher) · [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Bl0ck154%2Freddit-mcp-publisher/versions/0.3.3)

# Migrating to Reddit MCP Publisher (v0.3.1)

The project name, GitHub repository, preferred CLI, npm package name and MCP Registry identity have changed:

| Surface | Old | New |
| --- | --- | --- |
| GitHub | Bl0ck154/reddit-agent-publisher | Bl0ck154/reddit-mcp-publisher |
| GitHub source setup | npx -y github:Bl0ck154/reddit-agent-publisher setup | npx -y github:Bl0ck154/reddit-mcp-publisher setup |
| Preferred CLI | reddit-agent-publisher | reddit-mcp-publisher |
| npm (published) | reddit-agent-publisher | reddit-mcp-publisher |
| MCP Registry (published) | io.github.bl0ck154/reddit-agent-publisher | io.github.Bl0ck154/reddit-mcp-publisher |

The legacy **reddit-agent-publisher CLI executable remains available** in packages from v0.3.1.

## Existing installations

Do not delete or rename the existing ~/.local/share/reddit-agent-publisher directory, master.key, encrypted cookies, browser profiles, or systemd units named reddit-agent-publisher*. Their paths are intentionally unchanged; the new release still uses them. Renaming the GitHub repository does not restart or reconfigure a production installation.

Existing MCP client entries continue to work until you deliberately replace them. A fresh setup generates reddit-mcp-publisher entries. Avoid running two MCP entries against the same daemon.

For an existing Git checkout, update only the remote URL:

    git remote set-url origin https://github.com/Bl0ck154/reddit-mcp-publisher.git

GitHub redirects most old repository URLs, but explicitly update git remotes, CI workflow references, external catalogs and webhooks to the new URL.

## Browser compatibility

LightPanda can accelerate supported **reads** when it has an authenticated snapshot. The new default is a preference, not proof it will handle every Reddit page. Chrome remains the mandatory login, preview and write backend. No Chrome-free publishing or measured RAM-reduction claims are made.

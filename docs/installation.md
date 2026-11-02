# Installation and first login

The CLI needs **Node.js 22+** and a local Chrome/Chromium installation. The Reddit account is authenticated in its own browser profile; do not paste passwords, cookies, or 2FA codes into an AI conversation.

## Quick start

Requirements: **Node.js 22+**, npm, and Chrome/Chromium.

### One-command setup from npm

```bash
npx -y reddit-mcp-publisher setup
```

The installer detects the machine type and does the repetitive setup for you:

- detects Chrome/Chromium;
- creates the private Publisher state directory;
- generates and protects the AES master key;
- writes the local config;
- creates a stable runtime copy so services do not depend on npm cache paths;
- installs user-scoped daemon/browser services when systemd is available;
- generates Codex, Claude Desktop, OpenCode, and generic MCP configs;
- opens the normal Reddit browser login flow when a private desktop is available.

**Your Reddit password, 2FA code, CAPTCHA, and cookies stay in your browser.** Setup never asks the AI agent for them.

Useful variants:

```bash
npx -y reddit-mcp-publisher setup --client codex
npx -y reddit-mcp-publisher setup --mode server --client claude
```

The GitHub source installer is also available as an alternative:

```bash
npx -y github:Bl0ck154/reddit-mcp-publisher setup
```

Setup is safe to rerun: it keeps the existing master key and persistent Chrome profile instead of silently replacing them.

### Headless Linux / VPS

On a headless Linux machine, setup installs the Publisher daemon and managed browser unit. If `Xvfb` is already available, it also creates a private virtual desktop; if `x11vnc` is available too, VNC is bound to **localhost only** and is intended to be reached through SSH:

```bash
ssh -N -L 5901:127.0.0.1:5901 YOUR_USER@YOUR_SERVER
```

Then connect a VNC viewer to `localhost:5901` and complete Reddit login in Chrome once. Setup does not use `sudo` or install operating-system packages behind your back.

See [Browser modes](browser-modes.md) for desktop, VPS, and manual deployment details.

### Manual/source setup

The old explicit path remains available for advanced deployments:

```bash
git clone https://github.com/Bl0ck154/reddit-mcp-publisher.git
cd reddit-mcp-publisher
npm ci
npm run build
node dist/cli.js setup
```

After setup, normal CLI commands include:

```bash
reddit-mcp-publisher status
reddit-mcp-publisher reddit-activity --limit 10
reddit-mcp-publisher reddit-preflight GiftofGames --action comment
reddit-mcp-publisher reddit-inbox
```


## After setup

1. Complete Reddit login in the browser controlled by the account owner.
2. Run `reddit-mcp-publisher status` and confirm the intended account is authenticated.
3. Run `reddit-mcp-publisher reddit-preflight <subreddit>` before writing.
4. Ask your MCP client to prepare a draft, inspect the live preview, and approve an exact publish when ready.

If the CLI is not on your PATH after the one-off `npx` setup, use the generated MCP config or the CLI under your installed runtime. See [browser modes](browser-modes.md).

## Distribution status

The package is available on [npm](https://www.npmjs.com/package/reddit-mcp-publisher). Use the npm-based command above for a standard installation, or the GitHub source installer for development.

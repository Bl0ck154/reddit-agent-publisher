# Browser modes

Reddit Agent Publisher keeps Reddit authentication in an owner-controlled Chrome profile. The recommended path is now the setup command; the manual modes remain available for advanced deployments.

## Recommended: setup-managed install

From the GitHub repository package:

```bash
npx -y github:Bl0ck154/reddit-agent-publisher setup
```

After an npm registry release, the shorter equivalent is:

```bash
npx -y reddit-agent-publisher setup
```

The setup command:

- detects Chrome/Chromium;
- creates the private state directory and a 32-byte AES master key;
- writes `config.json` without overwriting unrelated existing settings;
- creates a stable runtime copy under the state directory so systemd does not depend on an npm cache path;
- installs a user `publisherd` service and a per-account Chrome service when systemd is available;
- generates Codex, Claude Desktop, OpenCode, and generic MCP config snippets;
- opens the normal Reddit login flow when a usable owner-controlled desktop is available.

Setup is safe to rerun. In particular, it does **not** rotate an existing master key or replace an authenticated Chrome profile.

Useful variants:

```bash
reddit-agent-publisher setup --mode desktop --client codex
reddit-agent-publisher setup --mode server --client claude
reddit-agent-publisher setup --no-systemd
reddit-agent-publisher setup --non-interactive
```

## Desktop behavior

On Linux with a working systemd user session, setup installs:

```text
~/.config/systemd/user/reddit-agent-publisher.service
~/.config/systemd/user/reddit-agent-publisher-browser@.service
```

The daemon starts automatically. Chrome is started on demand for the configured account, keeps its persistent profile under the Publisher state directory, and can be stopped after the configured idle period.

If user systemd is unavailable, setup falls back to a loopback-only portable CDP Chrome plus a detached local daemon. No public debugging port is opened.

## Headless Linux server

Use:

```bash
reddit-agent-publisher setup --mode server
```

The Publisher daemon and browser service are still user-scoped. If `Xvfb` is already installed, setup also creates a private `:98` virtual desktop. If `x11vnc` is installed as well, setup creates a VNC service with these security properties:

- listens on `localhost` only;
- no public TCP listener;
- intended to be reached through an SSH tunnel;
- exists only to let the owner complete browser authentication/challenges.

Typical one-time login tunnel:

```bash
ssh -N -L 5901:127.0.0.1:5901 YOUR_USER@YOUR_SERVER
```

Then connect your VNC viewer to `localhost:5901` and log into Reddit normally in Chrome.

If `Xvfb`/`x11vnc` are not installed, setup does not try to gain root privileges or install OS packages. It finishes the Publisher configuration and tells you that a private desktop is still needed.

## Authentication boundary

Passwords, 2FA, CAPTCHA, and consent are always completed manually in the owner-controlled browser. They are never requested by the MCP server, CLI, daemon, or AI agent.

The normal browser profile remains the source of authentication. The project does not copy Reddit cookies to a central service and does not require users to hand account credentials to the project owner.

## Manual portable local-CDP mode

Advanced users can still start Chrome themselves:

```bash
google-chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.reddit-agent-publisher-chrome"
```

Then:

```bash
export PUBLISHER_CDP_URL=http://127.0.0.1:9222
npm start
```

Remote CDP hosts are rejected. In portable mode the publisher never stops the browser because its lifecycle belongs to you.

## Manual managed-browser mode

If you do not use setup, the original managed-browser architecture is unchanged: `PUBLISHER_CDP_URL` is unset, and `ExternalChrome` starts a systemd user template named `reddit-agent-publisher-browser@.service` by default.

The repository ships `bin/start-browser`, which creates a persistent account profile and a stable loopback CDP port. The setup command simply automates creating the unit, state, key, configuration, and daemon around this existing mechanism.

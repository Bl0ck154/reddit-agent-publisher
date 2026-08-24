# Browser modes

Reddit Agent Publisher supports two ways to use Chrome. Both keep Reddit authentication in a normal owner-controlled browser profile.

## Portable local-CDP mode

This is the easiest way to run the public project on an existing machine. Start Chrome yourself with a loopback-only debugging port:

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

Remote CDP hosts are rejected. In this mode the publisher never stops the browser because its lifecycle belongs to you.

## Managed browser mode

If `PUBLISHER_CDP_URL` is unset, the publisher can manage one persistent Chrome profile per account through a systemd user template named `reddit-agent-publisher-browser@.service` by default.

The repository ships `bin/start-browser`, which creates a stable loopback CDP port for the selected account and starts Chrome at `about:blank`. A minimal user unit can call it like this:

```ini
[Unit]
Description=Reddit Agent Publisher browser (%i)

[Service]
Type=simple
Environment=PUBLISHER_STATE_DIR=%h/.local/share/reddit-agent-publisher
ExecStart=/absolute/path/reddit-agent-publisher/bin/start-browser %i
Restart=no
```

Install it as:

```text
~/.config/systemd/user/reddit-agent-publisher-browser@.service
```

Then run `systemctl --user daemon-reload`. The publisher starts the unit on demand, reuses the authenticated profile, pins Chrome while a live preview is waiting for approval, and stops idle managed Chrome after `browserIdleSeconds` (90 seconds by default).

You can override the template prefix with `PUBLISHER_BROWSER_SERVICE_PREFIX`.

## Authentication challenges

Passwords, 2FA, CAPTCHA, and similar challenges are completed manually in the browser. If the browser lives on a headless server, expose its desktop only through an owner-controlled method such as a localhost-only VNC tunnel. Do not send credentials through the agent or publisher API.

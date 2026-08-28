import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

type BrowserSession = {
  browser?: Browser;
  connecting?: Promise<Browser>;
  active: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  pins: Map<string, ReturnType<typeof setTimeout>>;
};

type BrowserTarget = {
  instance: string;
  profile: string;
};

export class ExternalChrome {
  private static sessions = new Map<string, BrowserSession>();

  constructor(private config: Config, private adapter: "reddit" = "reddit") {}

  async page(account: string): Promise<Page> {
    const target = this.target(account);
    const session = this.session(target.instance);
    this.cancelIdle(session);
    session.active += 1;

    try {
      const browser = await this.browser(target, session);
      const context: BrowserContext | undefined = browser.contexts()[0];
      if (!context) throw new Error("BROWSER_START_FAILED: normal Chrome has no default browser context");

      const pages = context.pages().filter(page => !page.isClosed());
      const sitePage = pages.find(page => this.matchesAdapter(page.url()));
      // A pinned page belongs to a live preview. Reusing it for another preview
      // would navigate the first draft away and make its approval stale. Once a
      // preview is pinned, isolate subsequent operations in another tab instead.
      if (sitePage && session.pins.size === 0) return sitePage;

      const blankPage = pages.find(page => page.url() === "about:blank");
      if (blankPage) return blankPage;

      // If nothing else is holding this shared profile, reuse the existing tab instead
      // of keeping a heavy Reddit page alive next to a new one.
      if (session.active === 1 && session.pins.size === 0 && pages.length) return pages[0];

      return await context.newPage();
    } catch (error) {
      session.active = Math.max(0, session.active - 1);
      this.scheduleIdle(target.instance, session);
      throw error;
    }
  }

  /**
   * Marks one acquired page operation as complete. The browser stays alive while
   * preview/login pins exist; otherwise it is stopped after the configured idle delay.
   */
  release(account: string): void {
    const target = this.target(account);
    const session = ExternalChrome.sessions.get(target.instance);
    if (!session) return;
    session.active = Math.max(0, session.active - 1);
    this.scheduleIdle(target.instance, session);
  }

  /** Keep the shared Chrome profile alive for a live preview/login handoff. */
  pin(account: string, key: string, ttlSeconds: number): void {
    const target = this.target(account);
    const session = this.session(target.instance);
    this.cancelIdle(session);

    const previous = session.pins.get(key);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      session.pins.delete(key);
      this.scheduleIdle(target.instance, session);
    }, Math.max(1, ttlSeconds) * 1000);
    timer.unref?.();
    session.pins.set(key, timer);
  }

  unpin(account: string, key: string): void {
    const target = this.target(account);
    const session = ExternalChrome.sessions.get(target.instance);
    if (!session) return;
    const timer = session.pins.get(key);
    if (timer) clearTimeout(timer);
    session.pins.delete(key);
    this.scheduleIdle(target.instance, session);
  }

  private target(account: string): BrowserTarget {
    const shared = account === "owner-main" || account === "reddit-main" || account === "default";
    const resolved = shared ? this.config.defaultAccount : account;
    const safe = resolved.replace(/[^a-z0-9_-]/gi, "_");
    const instance = safe;
    const profile = path.join(this.config.stateDir, "profiles", safe);
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    return { instance, profile };
  }

  private session(instance: string): BrowserSession {
    let session = ExternalChrome.sessions.get(instance);
    if (!session) {
      session = { active: 0, pins: new Map() };
      ExternalChrome.sessions.set(instance, session);
    }
    return session;
  }

  private async browser(target: BrowserTarget, session: BrowserSession): Promise<Browser> {
    if (session.browser?.isConnected()) return session.browser;
    if (session.connecting) return session.connecting;

    session.connecting = this.connect(target, session);
    try {
      return await session.connecting;
    } finally {
      session.connecting = undefined;
    }
  }

  private async connect(target: BrowserTarget, session: BrowserSession): Promise<Browser> {
    if (this.config.cdpUrl) {
      const endpoint = new URL(this.config.cdpUrl);
      const host = endpoint.hostname.toLowerCase();
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("BROWSER_CONFIG_INVALID: PUBLISHER_CDP_URL must point to a local Chrome debugging endpoint");
      const browser = await chromium.connectOverCDP(endpoint.toString());
      session.browser = browser;
      browser.on("disconnected", () => { if (session.browser === browser) session.browser = undefined; });
      return browser;
    }
    await this.systemctl(["start", `${this.config.browserServicePrefix}@${target.instance}.service`]);

    const portFile = path.join(target.profile, "PublisherDebugPort");
    let port = "";
    let last: unknown;
    let browser: Browser | undefined;

    for (let i = 0; i < 60; i += 1) {
      if (fs.existsSync(portFile)) {
        port = fs.readFileSync(portFile, "utf8").trim();
        if (/^\d{4,5}$/.test(port)) {
          try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
            break;
          } catch (error) {
            last = error;
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (!/^\d{4,5}$/.test(port)) throw new Error("BROWSER_START_FAILED: normal Chrome did not publish its local CDP port");
    if (!browser) throw new Error(`BROWSER_START_FAILED: cannot attach to normal Chrome: ${String(last)}`);

    session.browser = browser;
    browser.on("disconnected", () => {
      if (session.browser === browser) session.browser = undefined;
    });
    await new Promise(resolve => setTimeout(resolve, 350));
    return browser;
  }

  private scheduleIdle(instance: string, session: BrowserSession): void {
    this.cancelIdle(session);
    if (session.active > 0 || session.pins.size > 0 || session.connecting) return;

    if (this.config.cdpUrl) return;
    const idleSeconds = Math.max(5, Number(this.config.browserIdleSeconds ?? 90));
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      void this.stopIfIdle(instance, session);
    }, idleSeconds * 1000);
    session.idleTimer.unref?.();
  }

  private cancelIdle(session: BrowserSession): void {
    if (!session.idleTimer) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  private async stopIfIdle(instance: string, session: BrowserSession): Promise<void> {
    if (session.active > 0 || session.pins.size > 0 || session.connecting || this.config.cdpUrl) return;
    try {
      await this.systemctl(["stop", `${this.config.browserServicePrefix}@${instance}.service`]);
    } catch {
      // A hard systemd runtime limit still exists as a final cleanup guard.
    } finally {
      session.browser = undefined;
    }
  }

  private matchesAdapter(url: string): boolean {
    return /^https:\/\/(?:www\.|old\.|new\.)?reddit\.com(?:\/|$)/i.test(url);
  }

  private async systemctl(args: string[]): Promise<void> {
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
    await execFileAsync("systemctl", ["--user", ...args], {
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus`,
      },
    });
  }
}

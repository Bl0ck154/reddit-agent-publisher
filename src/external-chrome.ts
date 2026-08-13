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

export class ExternalChrome {
  private static sessions = new Map<string, BrowserSession>();

  constructor(private config: Config) {}

  async page(account: string): Promise<Page> {
    const session = this.session(account);
    this.cancelIdle(session);
    session.active += 1;
    try {
      const browser = await this.browser(account, session);
      const context: BrowserContext | undefined = browser.contexts()[0];
      if (!context) throw new Error("BROWSER_START_FAILED: Chrome has no default browser context");
      const pages = context.pages().filter((page) => !page.isClosed());
      const redditPage = pages.find((page) => /^https:\/\/(?:www\.|old\.|new\.)?reddit\.com(?:\/|$)/i.test(page.url()));
      if (redditPage) return redditPage;
      const blank = pages.find((page) => page.url() === "about:blank");
      if (blank) return blank;
      return pages[0] ?? await context.newPage();
    } catch (error) {
      session.active = Math.max(0, session.active - 1);
      this.scheduleIdle(account, session);
      throw error;
    }
  }

  release(account: string): void {
    const session = ExternalChrome.sessions.get(this.safe(account));
    if (!session) return;
    session.active = Math.max(0, session.active - 1);
    this.scheduleIdle(account, session);
  }

  pin(account: string, key: string, ttlSeconds: number): void {
    const session = this.session(account);
    this.cancelIdle(session);
    const previous = session.pins.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      session.pins.delete(key);
      this.scheduleIdle(account, session);
    }, Math.max(1, ttlSeconds) * 1000);
    timer.unref?.();
    session.pins.set(key, timer);
  }

  unpin(account: string, key: string): void {
    const session = ExternalChrome.sessions.get(this.safe(account));
    if (!session) return;
    const timer = session.pins.get(key);
    if (timer) clearTimeout(timer);
    session.pins.delete(key);
    this.scheduleIdle(account, session);
  }

  private safe(account: string): string {
    return (account === "default" ? this.config.defaultAccount : account).replace(/[^a-z0-9_-]/gi, "_");
  }

  private profile(account: string): string {
    const profile = path.join(this.config.stateDir, "profiles", this.safe(account));
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    return profile;
  }

  private session(account: string): BrowserSession {
    const key = this.safe(account);
    let session = ExternalChrome.sessions.get(key);
    if (!session) {
      session = { active: 0, pins: new Map() };
      ExternalChrome.sessions.set(key, session);
    }
    return session;
  }

  private async browser(account: string, session: BrowserSession): Promise<Browser> {
    if (session.browser?.isConnected()) return session.browser;
    if (session.connecting) return session.connecting;
    session.connecting = this.connect(account, session);
    try {
      return await session.connecting;
    } finally {
      session.connecting = undefined;
    }
  }

  private async connect(account: string, session: BrowserSession): Promise<Browser> {
    const instance = this.safe(account);
    await this.systemctl(["start", `reddit-agent-publisher-browser@${instance}.service`]);
    const portFile = path.join(this.profile(account), "PublisherDebugPort");
    let browser: Browser | undefined;
    let last: unknown;
    for (let i = 0; i < 60; i += 1) {
      if (fs.existsSync(portFile)) {
        const port = fs.readFileSync(portFile, "utf8").trim();
        if (/^\d{4,5}$/.test(port)) {
          try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
            break;
          } catch (error) {
            last = error;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!browser) throw new Error(`BROWSER_START_FAILED: cannot attach to Chrome: ${String(last)}`);
    session.browser = browser;
    browser.on("disconnected", () => {
      if (session.browser === browser) session.browser = undefined;
    });
    return browser;
  }

  private scheduleIdle(account: string, session: BrowserSession): void {
    this.cancelIdle(session);
    if (session.active > 0 || session.pins.size > 0 || session.connecting) return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      void this.stopIfIdle(account, session);
    }, Math.max(5, this.config.browserIdleSeconds) * 1000);
    session.idleTimer.unref?.();
  }

  private cancelIdle(session: BrowserSession): void {
    if (!session.idleTimer) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  private async stopIfIdle(account: string, session: BrowserSession): Promise<void> {
    if (session.active > 0 || session.pins.size > 0 || session.connecting) return;
    try {
      await this.systemctl(["stop", `reddit-agent-publisher-browser@${this.safe(account)}.service`]);
    } finally {
      session.browser = undefined;
    }
  }

  private async systemctl(args: string[]): Promise<void> {
    await execFileAsync("systemctl", ["--user", ...args]);
  }
}

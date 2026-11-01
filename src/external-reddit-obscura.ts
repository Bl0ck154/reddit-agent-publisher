import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "playwright-core";
import type { Config } from "./config.js";
import { open, seal } from "./crypto-store.js";

const REDDIT_AUTH_COOKIES = new Set(["reddit_session", "token_v2"]);

type ObscuraSession = {
  browser?: Browser;
  context?: BrowserContext;
  connecting?: Promise<Browser>;
  active: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  pins: Map<string, ReturnType<typeof setTimeout>>;
  authImported?: boolean;
  target?: ObscuraTarget;
  process?: ChildProcess;
};

type ObscuraTarget = {
  instance: string;
  storageDir: string;
  authFile: string;
  port: number;
};

export function isRedditCookie(cookie: Pick<Cookie, "domain">): boolean {
  const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  return domain === "reddit.com" || domain.endsWith(".reddit.com");
}

export function hasRedditAuthCookie(cookies: Array<Pick<Cookie, "name" | "domain">>): boolean {
  return cookies.some(cookie => isRedditCookie(cookie as Pick<Cookie, "domain">) && REDDIT_AUTH_COOKIES.has(cookie.name));
}

export class ExternalRedditObscura {
  private static sessions = new Map<string, ObscuraSession>();

  constructor(private config: Config, private mode: "obscura" | "lightpanda" = "obscura") {}

  async page(account: string): Promise<Page> {
    const target = this.target(account);
    const session = this.session(target.instance);
    session.target = target;
    this.cancelIdle(session);
    session.active += 1;

    try {
      const browser = await this.browser(target, session);
      let context = session.context ?? browser.contexts()[0];
      // Refresh a Lightpanda context closed without a browser disconnect.
      if (this.mode === "lightpanda" && (!context || context.isClosed())) {
        context = await browser.newContext();
        session.context = context;
        session.authImported = false;
      }
      if (!context) throw new Error("REDDIT_BROWSER_START_FAILED: no browser context");
      await this.restoreAuth(target, session, context);

      const pages = context.pages().filter(page => !page.isClosed());
      const redditPage = pages.find(page => /^https:\/\/(?:www\.)?reddit\.com(?:\/|$)/i.test(page.url()));
      if (redditPage && session.pins.size === 0) return redditPage;
      const blank = pages.find(page => page.url() === "about:blank");
      if (blank) return blank;
      if (session.active === 1 && session.pins.size === 0 && pages.length) return pages[0];
      return await context.newPage();
    } catch (error) {
      session.active = Math.max(0, session.active - 1);
      this.scheduleIdle(target.instance, session);
      throw error;
    }
  }

  async shutdown(account: string): Promise<void> {
    const target = this.target(account);
    const session = ExternalRedditObscura.sessions.get(target.instance);
    if (!session) return;
    this.cancelIdle(session);
    if (session.active > 0 || session.pins.size > 0 || session.connecting) return;
    await this.stopIfIdle(target.instance, session);
  }

  async release(account: string): Promise<void> {
    const target = this.target(account);
    const session = ExternalRedditObscura.sessions.get(target.instance);
    if (!session) return;
    try {
      const context = session.browser?.isConnected() ? session.context ?? session.browser.contexts()[0] : undefined;
      if (context) await this.persistAuth(target, context);
    } catch {
      // Keep the last valid encrypted snapshot if Reddit rotates state unexpectedly.
    } finally {
      session.active = Math.max(0, session.active - 1);
      this.scheduleIdle(target.instance, session);
    }
  }

  pin(account: string, key: string, ttlSeconds: number): void {
    const target = this.target(account);
    const session = this.session(target.instance);
    session.target = target;
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
    const session = ExternalRedditObscura.sessions.get(target.instance);
    if (!session) return;
    const timer = session.pins.get(key);
    if (timer) clearTimeout(timer);
    session.pins.delete(key);
    this.scheduleIdle(target.instance, session);
  }

  async importRedditCookies(account: string, cookies: Cookie[]): Promise<number> {
    const target = this.target(account);
    const redditCookies = cookies.filter(cookie => isRedditCookie(cookie));
    if (!hasRedditAuthCookie(redditCookies)) return 0;
    this.writeAuth(target.authFile, redditCookies);

    const session = ExternalRedditObscura.sessions.get(target.instance);
    const context = session?.browser?.isConnected() ? session.context ?? session.browser.contexts()[0] : undefined;
    if (context) {
      await context.addCookies(this.toSetCookies(redditCookies));
      session!.authImported = true;
    }
    return redditCookies.length;
  }

  hasAuthSnapshot(account: string): boolean {
    return hasRedditAuthCookie(this.readAuth(this.target(account).authFile));
  }

  private target(account: string): ObscuraTarget {
    const shared = account === "owner-main" || account === "reddit-main" || account === "default";
    const safe = shared ? "owner-main" : account.replace(/[^a-z0-9_-]/gi, "_");
    const storageDir = path.join(this.config.stateDir, this.mode, "reddit", safe);
    const authDir = this.mode === "lightpanda" ? path.join(this.config.stateDir, "auth", "lightpanda") : path.join(this.config.stateDir, "auth", "reddit");
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(storageDir, 0o700);
    fs.chmodSync(authDir, 0o700);
    const instance = `${this.mode}__reddit__${safe}`;
    const checksum = Buffer.from(instance).reduce((sum, byte) => (sum + byte) >>> 0, 0);
    return {
      instance,
      storageDir,
      authFile: path.join(authDir, `${safe}.cookies.enc`),
      port: (this.mode === "lightpanda" ? 12300 : 11300) + (checksum % 500),
    };
  }

  private session(instance: string): ObscuraSession {
    let session = ExternalRedditObscura.sessions.get(instance);
    if (!session) {
      session = { active: 0, pins: new Map() };
      ExternalRedditObscura.sessions.set(instance, session);
    }
    return session;
  }

  private async browser(target: ObscuraTarget, session: ObscuraSession): Promise<Browser> {
    if (session.browser?.isConnected()) return session.browser;
    if (session.connecting) return session.connecting;
    session.connecting = this.connect(target, session);
    try {
      return await session.connecting;
    } finally {
      session.connecting = undefined;
    }
  }

  private async connect(target: ObscuraTarget, session: ObscuraSession): Promise<Browser> {
    const executable = this.mode === "lightpanda" ? this.config.lightpandaPath ?? "/usr/local/bin/lightpanda" : this.config.obscuraPath ?? "/opt/agent-publisher/vendor/obscura/obscura";
    if (path.isAbsolute(executable) && !fs.existsSync(executable)) throw new Error(`OBSCURA_START_FAILED: executable not found at ${executable}`);
    const portFile = path.join(target.storageDir, "ObscuraDebugPort");
    fs.writeFileSync(portFile, `${target.port}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(portFile, 0o600);

    const args = this.mode === "lightpanda"
      ? ["serve", "--host", "127.0.0.1", "--port", String(target.port), "--disable-metrics"]
      : ["--stealth", "--storage-dir", target.storageDir,
         "serve", "--host", "127.0.0.1", "--port", String(target.port), "--max-connections", "8"];
    const child = spawn(executable, args, {
      stdio: "ignore",
      env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true", LIGHTPANDA_DISABLE_CORE_DUMP: "1" },
    });
    session.process = child;
    child.once("exit", () => {
      if (session.process === child) session.process = undefined;
      if (session.browser?.isConnected()) void session.browser.close().catch(() => undefined);
      session.browser = undefined;
    });

    let browser: Browser | undefined;
    let last: unknown;
    for (let i = 0; i < 80; i += 1) {
      if (child.exitCode !== null) break;
      try {
        browser = await chromium.connectOverCDP(`${this.mode === "lightpanda" ? "ws" : "http"}://127.0.0.1:${target.port}`);
        break;
      } catch (error) {
        last = error;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!browser) {
      if (child.exitCode === null) child.kill("SIGTERM");
      session.process = undefined;
      throw new Error(`OBSCURA_START_FAILED: cannot attach to local CDP endpoint: ${String(last)}`);
    }

    if (this.mode === "lightpanda") {
      try { session.context = await browser.newContext(); }
      catch (error) {
        await browser.close().catch(() => undefined);
        if (child.exitCode === null) child.kill("SIGTERM");
        throw error;
      }
    }
    session.authImported = false;
    session.browser = browser;
    browser.on("disconnected", () => {
      if (session.browser === browser) session.browser = undefined;
    });
    return browser;
  }

  private async restoreAuth(target: ObscuraTarget, session: ObscuraSession, context: BrowserContext): Promise<void> {
    if (session.authImported) return;
    const cookies = this.readAuth(target.authFile);
    if (cookies.length) await context.addCookies(this.toSetCookies(cookies));
    session.authImported = true;
  }

  private async persistAuth(target: ObscuraTarget, context: BrowserContext): Promise<void> {
    const cookies = (await context.cookies()).filter(cookie => isRedditCookie(cookie));
    if (!hasRedditAuthCookie(cookies)) return;
    this.writeAuth(target.authFile, cookies);
  }

  private readAuth(authFile: string): Cookie[] {
    if (!fs.existsSync(authFile)) return [];
    try {
      const value = open<unknown>(fs.readFileSync(authFile, "utf8").trim());
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is Cookie => Boolean(item && typeof item === "object" && "name" in item && "value" in item && "domain" in item));
    } catch {
      return [];
    }
  }

  private writeAuth(authFile: string, cookies: Cookie[]): void {
    const tmp = `${authFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, seal(cookies), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, authFile);
    fs.chmodSync(authFile, 0o600);
  }

  private toSetCookies(cookies: Cookie[]): Parameters<BrowserContext["addCookies"]>[0] {
    return cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  }

  private scheduleIdle(instance: string, session: ObscuraSession): void {
    this.cancelIdle(session);
    if (session.active > 0 || session.pins.size > 0 || session.connecting) return;
    const idleSeconds = Math.max(5, Number(this.config.browserIdleSeconds ?? 90));
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      void this.stopIfIdle(instance, session);
    }, idleSeconds * 1000);
    session.idleTimer.unref?.();
  }

  private cancelIdle(session: ObscuraSession): void {
    if (!session.idleTimer) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  private async stopIfIdle(instance: string, session: ObscuraSession): Promise<void> {
    if (session.active > 0 || session.pins.size > 0 || session.connecting) return;
    try {
      const context = session.browser?.isConnected() ? session.context ?? session.browser.contexts()[0] : undefined;
      if (context && session.target) await this.persistAuth(session.target, context).catch(() => undefined);
      if (session.browser?.isConnected()) await session.browser.close().catch(() => undefined);
      if (session.process && session.process.exitCode === null) session.process.kill("SIGTERM");
    } finally {
      session.browser = undefined;
      session.context = undefined;
      session.process = undefined;
      session.authImported = false;
      ExternalRedditObscura.sessions.delete(instance);
    }
  }
}

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Config } from "./config.js";

type BrowserSession = {
  browser?: Browser;
  connecting?: Promise<Browser>;
};

export class ExternalChrome {
  private static sessions = new Map<string, BrowserSession>();

  constructor(private config: Config) {}

  async page(account: string): Promise<Page> {
    const session = this.session(account);
    const browser = await this.browser(session);
    const context: BrowserContext | undefined = browser.contexts()[0];
    if (!context) throw new Error("BROWSER_START_FAILED: Chrome has no default browser context");

    const pages = context.pages().filter((page) => !page.isClosed());
    const redditPage = pages.find((page) => /^https:\/\/(?:www\.|old\.|new\.)?reddit\.com(?:\/|$)/i.test(page.url()));
    if (redditPage) return redditPage;

    const blank = pages.find((page) => page.url() === "about:blank");
    if (blank) return blank;

    return pages[0] ?? await context.newPage();
  }

  release(_account: string): void {
    // Chrome is user-owned and intentionally remains running.
  }

  pin(_account: string, _key: string, _ttlSeconds: number): void {
    // The external Chrome lifecycle is controlled by the user, not the publisher.
  }

  unpin(_account: string, _key: string): void {
    // No-op for the portable external-CDP backend.
  }

  private effectiveAccount(account: string): string {
    return account === "default" ? this.config.defaultAccount : account;
  }

  private session(account: string): BrowserSession {
    const key = this.effectiveAccount(account).replace(/[^a-z0-9_-]/gi, "_");
    let session = ExternalChrome.sessions.get(key);
    if (!session) {
      session = {};
      ExternalChrome.sessions.set(key, session);
    }
    return session;
  }

  private async browser(session: BrowserSession): Promise<Browser> {
    if (session.browser?.isConnected()) return session.browser;
    if (session.connecting) return session.connecting;

    session.connecting = this.connect();
    try {
      const browser = await session.connecting;
      session.browser = browser;
      browser.on("disconnected", () => {
        if (session.browser === browser) session.browser = undefined;
      });
      return browser;
    } finally {
      session.connecting = undefined;
    }
  }

  private async connect(): Promise<Browser> {
    const endpoint = new URL(this.config.cdpUrl);
    const host = endpoint.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
      throw new Error("BROWSER_CONFIG_INVALID: PUBLISHER_CDP_URL must point to a local Chrome debugging endpoint");
    }

    try {
      return await chromium.connectOverCDP(endpoint.toString());
    } catch (error) {
      throw new Error(`BROWSER_START_FAILED: cannot connect to Chrome at ${endpoint.origin}: ${String(error)}`);
    }
  }
}

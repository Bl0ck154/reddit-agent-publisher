import fs from "node:fs";
import path from "node:path";
import { type Locator, type Page } from "playwright-core";
import type { Config } from "../config.js";
import { ExternalChrome } from "../external-chrome.js";
import type { Draft } from "../types.js";
import type { Adapter, PreviewData, PublishData } from "./base.js";
import { PublisherError } from "../errors.js";

type PreviewSession = {
  page: Page;
  action: Draft["action"];
  pageUrl: string;
  targetScope: Locator;
  submit?: Locator;
  deleteControl?: Locator;
  titleField?: Locator;
  bodyField?: Locator;
  linkField?: Locator;
  title?: string;
  body?: string;
  outboundUrl?: string;
};

type TargetIdentity = {
  subreddit: string;
  postId: string;
  commentId?: string;
  fullname: string;
  permalink: string;
};

type CacheEntry = {
  value: Record<string, unknown>;
  expiresAt: number;
};

export class RedditBrowserAdapter implements Adapter {
  readonly id = "reddit";
  private chrome: ExternalChrome;
  private previews = new Map<string, PreviewSession>();
  private previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rulesCache = new Map<string, CacheEntry>();
  private flairsCache = new Map<string, CacheEntry>();

  constructor(private config: Config) {
    this.chrome = new ExternalChrome(config);
  }

  async validate(draft: Draft): Promise<void> {
    if (draft.action === "create_post") {
      if (!draft.target.subreddit || !String(draft.content.title ?? "").trim()) throw new Error("subreddit and title are required");
      this.subreddit(String(draft.target.subreddit));
      const media = this.mediaFiles(draft);
      if (media.length && draft.content.url) {
        throw new PublisherError("REDDIT_POST_TYPE_CONFLICT", "A Reddit post cannot contain both uploaded images and a link URL.");
      }
      return;
    }
    if (draft.action === "create_comment") {
      if (!draft.target.url || !String(draft.content.body ?? "").trim()) throw new Error("An exact Reddit permalink and body are required");
      this.permalink(String(draft.target.url));
      return;
    }
    if (draft.action === "edit" || draft.action === "delete") {
      if (!draft.target.url) throw new Error("An exact Reddit permalink is required for edit/delete");
      this.permalink(String(draft.target.url));
      if (draft.action === "edit" && !String(draft.content.body ?? "").trim()) throw new Error("body is required for edit");
      return;
    }
    throw new Error(`Unsupported Reddit action: ${draft.action}`);
  }

  async login(account: string): Promise<Record<string, unknown>> {
    const page = await this.chrome.page(account);
    try {
      await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.assertOrigin(page.url());
      if (await this.cookieAuthenticated(page) && !await this.gate(page)) {
        return { status: "ALREADY_AUTHENTICATED", account, current_url: page.url() };
      }
      await page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.chrome.pin(account, `login:${account}`, this.config.approvalTtlSeconds);
      return {
        status: "USER_ACTION_REQUIRED",
        account,
        current_url: page.url(),
        instructions: "Complete Reddit login in the owner-controlled Chrome session, then retry the requested operation."
      };
    } finally {
      this.chrome.release(account);
    }
  }

  async status(account: string): Promise<Record<string, unknown>> {
    const page = await this.chrome.page(account);
    try {
      const hasSession = await this.cookieAuthenticated(page);
      if (!this.isRedditPage(page.url())) {
        await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      const gate = await this.gate(page);
      const authenticated = hasSession && !gate;
      if (authenticated) this.chrome.unpin(account, `login:${account}`);
      return { authenticated, account, current_url: page.url(), note: gate ?? "Reddit session is available." };
    } finally {
      this.chrome.release(account);
    }
  }

  async rules(account: string, subreddit: string): Promise<Record<string, unknown>> {
    const sub = this.subreddit(subreddit);
    const key = `${account}:${sub.toLowerCase()}`;
    const cached = this.rulesCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };
    const page = await this.chrome.page(account);
    try {
      await page.goto(`https://www.reddit.com/r/${encodeURIComponent(sub)}/about/rules`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.assertOrigin(page.url());
      await this.requireAuth(page);
      const main = page.getByRole("main");
      await main.waitFor({ state: "visible", timeout: 20_000 });
      const value = { subreddit: sub, url: page.url(), text: (await main.innerText()).slice(0, 40_000), cached: false, fetched_at: new Date().toISOString() };
      this.rulesCache.set(key, { value, expiresAt: Date.now() + this.config.redditMetadataCacheSeconds * 1000 });
      return value;
    } finally {
      this.chrome.release(account);
    }
  }

  async flairs(account: string, subreddit: string): Promise<Record<string, unknown>> {
    const sub = this.subreddit(subreddit);
    const key = `${account}:${sub.toLowerCase()}`;
    const cached = this.flairsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };
    const page = await this.chrome.page(account);
    try {
      await page.goto(`https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?type=TEXT`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.assertOrigin(page.url());
      await this.requireAuth(page);
      const trigger = await this.findVisible(page, [
        page.getByRole("button", { name: /flair/i }),
        page.getByRole("combobox", { name: /flair/i })
      ]);
      if (!trigger) return { subreddit: sub, flairs: [], cached: false, fetched_at: new Date().toISOString() };
      await trigger.click();
      const labels = [
        ...await page.getByRole("radio").allTextContents().catch(() => []),
        ...await page.getByRole("option").allTextContents().catch(() => [])
      ].map((value) => value.trim()).filter(Boolean);
      const value = { subreddit: sub, flairs: [...new Set(labels)], cached: false, fetched_at: new Date().toISOString() };
      this.flairsCache.set(key, { value, expiresAt: Date.now() + this.config.redditMetadataCacheSeconds * 1000 });
      return value;
    } finally {
      this.chrome.release(account);
    }
  }

  async preview(draft: Draft): Promise<PreviewData> {
    const page = await this.chrome.page(draft.account);
    try {
      let session: PreviewSession;
      if (draft.action === "create_post") session = await this.previewPost(page, draft);
      else if (draft.action === "create_comment") session = await this.previewComment(page, draft);
      else session = await this.previewMutation(page, draft);
      const artifact = await this.shot(page, draft.id);
      this.rememberPreview(draft, session);
      return {
        summary: {
          action: draft.action,
          account: draft.account,
          target: draft.target,
          content: draft.action === "delete" ? {} : draft.content,
          current_url: page.url(),
          notice: "The live Reddit form was prepared for review."
        },
        artifact_path: artifact
      };
    } finally {
      this.chrome.release(draft.account);
    }
  }

  approved(draft: Draft): void {
    if (!this.previews.has(draft.id)) return;
    this.chrome.pin(draft.account, this.previewPin(draft.id), this.config.approvalTtlSeconds);
  }

  async publish(draft: Draft): Promise<PublishData> {
    const session = this.previews.get(draft.id);
    if (!session || session.page.isClosed()) throw new Error("APPROVAL_STALE: browser preview no longer exists");
    try {
      if (session.page.url() !== session.pageUrl || session.action !== draft.action) throw new Error("APPROVAL_STALE: Reddit page changed after preview");
      await this.verifyForm(session);
      if (draft.action === "delete") {
        if (!session.deleteControl) throw new Error("APPROVAL_STALE: Delete control disappeared");
        await session.deleteControl.click();
        const confirm = await this.findVisible(session.page, [session.page.getByRole("button", { name: /^delete$/i })]);
        if (!confirm) throw new Error("SITE_CHANGED: delete confirmation was not found");
        await confirm.click();
      } else {
        if (!session.submit) throw new Error("APPROVAL_STALE: submit control disappeared");
        const before = session.page.url();
        await session.submit.click();
        if (draft.action === "create_post") {
          await session.page.waitForURL((url) => url.toString() !== before, { timeout: 20_000 })
            .catch(() => { throw new Error("PUBLISH_RESULT_AMBIGUOUS: Reddit did not navigate after submit"); });
        }
      }
      const alerts = await session.page.getByRole("alert").allTextContents().catch(() => []);
      if (alerts.some((value) => value.trim())) throw new Error(`PUBLISH_RESULT_AMBIGUOUS: Reddit alert: ${alerts.join(" | ").slice(0, 300)}`);
      return { status: "PUBLISHED", url: session.page.url(), warnings: [] };
    } finally {
      this.forgetPreview(draft.id);
      this.chrome.unpin(draft.account, this.previewPin(draft.id));
    }
  }

  async diagnose(live: boolean): Promise<Record<string, unknown>> {
    const chromeExists = fs.existsSync(this.config.chromePath);
    if (!live) return { adapter: "reddit", chrome_exists: chromeExists, display: this.config.display };
    const page = await this.chrome.page("default");
    try {
      await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      return { adapter: "reddit", chrome_exists: chromeExists, reddit_reachable: this.isRedditPage(page.url()), authenticated: await this.cookieAuthenticated(page) && !await this.gate(page) };
    } finally {
      this.chrome.release("default");
    }
  }

  private async previewPost(page: Page, draft: Draft): Promise<PreviewSession> {
    const sub = this.subreddit(String(draft.target.subreddit));
    const media = this.mediaFiles(draft);
    const type = media.length ? "IMAGE" : draft.content.url ? "LINK" : "TEXT";
    await page.goto(`https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?type=${type}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    this.assertOrigin(page.url());
    await this.requireAuth(page);
    const titleField = await this.needTextbox(page, [/title/i, /заголов/i]);
    await titleField.fill(String(draft.content.title));
    let bodyField: Locator | undefined;
    let linkField: Locator | undefined;
    if (media.length) {
      const input = page.locator('input[type="file"][accept*="image"]');
      if (await input.count() < 1) throw new Error("SITE_CHANGED: image upload input was not found");
      await input.first().setInputFiles(media);
    } else if (draft.content.url) {
      linkField = await this.needTextbox(page, [/url/i, /link/i, /посилання/i]);
      await linkField.fill(String(draft.content.url));
    } else if (draft.content.body) {
      bodyField = await this.needTextbox(page, [/body/i, /^text$/i, /текст/i], titleField);
      await bodyField.fill(String(draft.content.body));
    }
    if (draft.content.flair) await this.chooseFlair(page, String(draft.content.flair));
    const submit = await this.needButton(page, [/^post$/i, /publish/i, /опублікувати/i]);
    return {
      page,
      action: draft.action,
      pageUrl: page.url(),
      targetScope: page.getByRole("main"),
      submit,
      titleField,
      bodyField,
      linkField,
      title: String(draft.content.title),
      body: draft.content.body ? String(draft.content.body) : undefined,
      outboundUrl: draft.content.url ? String(draft.content.url) : undefined
    };
  }

  private async previewComment(page: Page, draft: Draft): Promise<PreviewSession> {
    const target = this.permalink(String(draft.target.url));
    await page.goto(target.permalink, { waitUntil: "domcontentloaded", timeout: 30_000 });
    this.assertOrigin(page.url());
    await this.requireAuth(page);
    const scope = await this.targetScope(page, target);
    if (target.commentId) {
      const reply = await this.findVisible(scope, [scope.getByRole("button", { name: /reply|comment|відповісти/i })]);
      if (reply) await reply.click();
    }
    const bodyField = await this.needTextbox(scope, [/comment|reply|коментар|відповід/i]).catch(() => this.needTextbox(page, [/comment|reply|коментар|відповід/i]));
    await bodyField.fill(String(draft.content.body));
    const submit = await this.needButton(page, [/^comment$/i, /^reply$/i, /відповісти/i]);
    return { page, action: draft.action, pageUrl: page.url(), targetScope: scope, submit, bodyField, body: String(draft.content.body) };
  }

  private async previewMutation(page: Page, draft: Draft): Promise<PreviewSession> {
    const target = this.permalink(String(draft.target.url));
    await page.goto(target.permalink, { waitUntil: "domcontentloaded", timeout: 30_000 });
    this.assertOrigin(page.url());
    await this.requireAuth(page);
    const scope = await this.targetScope(page, target);
    const more = await this.findVisible(scope, [scope.getByRole("button", { name: /more|options|actions/i })]);
    if (more) await more.click();
    if (draft.action === "delete") {
      const control = await this.findVisible(scope, [scope.getByRole("button", { name: /^delete$/i }), scope.getByRole("menuitem", { name: /^delete$/i })]);
      if (!control) throw new Error("OWNERSHIP_UNVERIFIED: Delete is unavailable for this target");
      return { page, action: draft.action, pageUrl: page.url(), targetScope: scope, deleteControl: control };
    }
    const edit = await this.findVisible(scope, [scope.getByRole("button", { name: /^edit$/i }), scope.getByRole("menuitem", { name: /^edit$/i })]);
    if (!edit) throw new Error("OWNERSHIP_UNVERIFIED: Edit is unavailable for this target");
    await edit.click();
    const bodyField = await this.needTextbox(scope, [/body|text|comment/i]);
    await bodyField.fill(String(draft.content.body));
    const submit = await this.needButton(scope, [/^save$/i]);
    return { page, action: draft.action, pageUrl: page.url(), targetScope: scope, submit, bodyField, body: String(draft.content.body) };
  }

  private mediaFiles(draft: Draft): string[] {
    if (draft.content.media_files === undefined) return [];
    if (!Array.isArray(draft.content.media_files) || draft.content.media_files.length < 1 || draft.content.media_files.length > 4) {
      throw new PublisherError("REDDIT_MEDIA_INVALID", "media_files must contain between one and four local image paths");
    }
    const root = path.resolve(this.config.stateDir, "artifacts") + path.sep;
    return draft.content.media_files.map((item) => {
      const raw = typeof item === "string" ? item : String((item as Record<string, unknown>)?.path ?? "");
      const resolved = fs.realpathSync(raw);
      if (!resolved.startsWith(root)) throw new PublisherError("REDDIT_MEDIA_FORBIDDEN", "Image files must be stored under the Publisher artifacts directory");
      return resolved;
    });
  }

  private async chooseFlair(page: Page, name: string): Promise<void> {
    const trigger = await this.findVisible(page, [page.getByRole("button", { name: /flair/i }), page.getByRole("combobox", { name: /flair/i })]);
    if (!trigger) throw new Error("SITE_CHANGED: flair control was not found");
    await trigger.click();
    const exact = page.getByText(name, { exact: true });
    const option = await this.findVisible(page, [exact]);
    if (!option) throw new Error("SITE_CHANGED: requested flair was not found");
    await option.click();
    const add = await this.findVisible(page, [page.getByRole("button", { name: /^add$/i })]);
    if (add) await add.click();
  }

  private async verifyForm(session: PreviewSession): Promise<void> {
    if (!await session.targetScope.isVisible().catch(() => false)) throw new Error("APPROVAL_STALE: target is no longer visible");
    if (session.titleField && await session.titleField.inputValue() !== session.title) throw new Error("APPROVAL_STALE: title changed after preview");
    if (session.bodyField && await this.fieldValue(session.bodyField) !== session.body) throw new Error("APPROVAL_STALE: body changed after preview");
    if (session.linkField && await session.linkField.inputValue() !== session.outboundUrl) throw new Error("APPROVAL_STALE: URL changed after preview");
  }

  private async targetScope(page: Page, target: TargetIdentity): Promise<Locator> {
    const selectors = target.commentId
      ? [`shreddit-comment[thingid="${target.fullname}"]`, `[data-fullname="${target.fullname}"]`]
      : [`shreddit-post[id="${target.fullname}"]`, `[data-fullname="${target.fullname}"]`];
    for (const selector of selectors) {
      const locator = page.locator(selector);
      if (await this.visibleCount(locator) === 1) return locator.filter({ visible: true }).first();
    }
    throw new Error(`SITE_CHANGED: target ${target.fullname} was not found`);
  }

  private permalink(value: string): TargetIdentity {
    const url = new URL(value);
    this.assertOrigin(url.toString());
    const match = url.pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?\/?$/i);
    if (!match) throw new Error("Reddit target must be a canonical post/comment permalink");
    const commentId = match[3];
    return {
      subreddit: match[1],
      postId: match[2],
      commentId,
      fullname: commentId ? `t1_${commentId}` : `t3_${match[2]}`,
      permalink: `https://www.reddit.com${url.pathname}`
    };
  }

  private subreddit(value: string): string {
    const result = value.replace(/^r\//, "");
    if (!/^[A-Za-z0-9_]{2,21}$/.test(result)) throw new Error("Invalid subreddit name");
    return result;
  }

  private assertOrigin(value: string): void {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(host)) {
      throw new Error("Only canonical HTTPS Reddit URLs are allowed");
    }
  }

  private isRedditPage(value: string): boolean {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(host);
    } catch {
      return false;
    }
  }

  private async gate(page: Page): Promise<string | undefined> {
    if (page.url().includes("/login")) return "AUTH_REQUIRED: complete Reddit login in the browser session";
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 3000);
    if (/request has been blocked|whoa there|network security/i.test(body)) return "TAKEOVER_REQUIRED: Reddit requires user interaction in the browser";
    return undefined;
  }

  private async requireAuth(page: Page): Promise<void> {
    const gate = await this.gate(page);
    if (gate) throw new Error(gate);
    if (!await this.cookieAuthenticated(page)) throw new Error("AUTH_REQUIRED: Reddit session cookie is not available");
  }

  private async cookieAuthenticated(page: Page): Promise<boolean> {
    const names = (await page.context().cookies()).filter((cookie) => cookie.domain.includes("reddit")).map((cookie) => cookie.name);
    return names.includes("reddit_session") || names.includes("token_v2");
  }

  private async needTextbox(scope: Page | Locator, names: RegExp[], exclude?: Locator): Promise<Locator> {
    for (const name of names) {
      const candidates = [scope.getByRole("textbox", { name }), scope.getByLabel(name), scope.getByPlaceholder(name)];
      for (const candidate of candidates) {
        for (let index = 0; index < await candidate.count(); index += 1) {
          const item = candidate.nth(index);
          if (!await item.isVisible().catch(() => false)) continue;
          if (exclude) {
            const a = await item.elementHandle();
            const b = await exclude.elementHandle();
            if (a && b && a === b) continue;
          }
          return item;
        }
      }
    }
    throw new Error("SITE_CHANGED: expected textbox was not found");
  }

  private async needButton(scope: Page | Locator, names: RegExp[]): Promise<Locator> {
    for (const name of names) {
      const button = await this.findVisible(scope, [scope.getByRole("button", { name })]);
      if (button) return button;
    }
    throw new Error("SITE_CHANGED: expected action button was not found");
  }

  private async findVisible(_scope: Page | Locator, candidates: Locator[]): Promise<Locator | undefined> {
    for (const candidate of candidates) {
      for (let index = 0; index < await candidate.count(); index += 1) {
        const item = candidate.nth(index);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    return undefined;
  }

  private async visibleCount(locator: Locator): Promise<number> {
    let count = 0;
    for (let index = 0; index < await locator.count(); index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) count += 1;
    }
    return count;
  }

  private async fieldValue(locator: Locator): Promise<string> {
    return await locator.inputValue().catch(async () => await locator.innerText());
  }

  private async shot(page: Page, id: string): Promise<string> {
    const file = path.join(this.config.stateDir, "artifacts", `${id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    fs.chmodSync(file, 0o600);
    return file;
  }

  private previewPin(id: string): string {
    return `preview:${id}`;
  }

  private rememberPreview(draft: Draft, session: PreviewSession): void {
    this.forgetPreview(draft.id);
    this.previews.set(draft.id, session);
    this.chrome.pin(draft.account, this.previewPin(draft.id), this.config.approvalTtlSeconds);
    const timer = setTimeout(() => this.forgetPreview(draft.id), (this.config.approvalTtlSeconds + 5) * 1000);
    timer.unref?.();
    this.previewTimers.set(draft.id, timer);
  }

  private forgetPreview(id: string): void {
    const timer = this.previewTimers.get(id);
    if (timer) clearTimeout(timer);
    this.previewTimers.delete(id);
    this.previews.delete(id);
  }
}

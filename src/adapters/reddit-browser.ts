import fs from "node:fs";
import path from "node:path";
import { type Locator, type Page } from "playwright-core";
import type { Config } from "../config.js";
import { ExternalChrome } from "../external-chrome.js";
import type { Draft } from "../types.js";
import type { Adapter, PreviewData, PublishData } from "./base.js";
import { PublisherError } from "../errors.js";

type Role = "button" | "menuitem" | "link" | "combobox" | "tab";
type MediaFile = { path: string; name: string; mime_type: string; size: number; sha256: string };
type TargetIdentity = { subreddit: string; postId: string; commentId?: string; fullname: string; permalink: string };
type PreviewSession = {
  page: Page; action: Draft["action"]; pageUrl: string; targetIdentity: string; targetScope: Locator;
  submit?: Locator; deleteControl?: Locator; titleField?: Locator; bodyField?: Locator; linkField?: Locator;
  title?: string; body?: string; outboundUrl?: string; flair?: string; flairControl?: Locator;
  mediaScope?: Locator;
};
type CacheEntry = { value: Record<string, unknown>; storedAt: number; expiresAt: number };
type LeanState = { enabled: boolean };

export function extractCommunityRulesText(raw: string): string | undefined {
  const text = raw.replace(/\r/g, "").trim();
  const marker = text.match(/(?:^|\n)\s*Community Rules\s*(?:\n|$)/i);
  if (!marker || marker.index === undefined) return undefined;
  const rules = text.slice(marker.index).trim();
  return rules.length > "Community Rules".length ? rules.slice(0, 40_000) : undefined;
}

export function normalizeFlairOptions(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map(value => value.replace(/\s+/g, " ").trim()).filter(value => {
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function detectRedditTargetUnavailableText(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/\bPage not found\b/i.test(normalized)) return "page_not_found";
  if (/\b(?:this )?post (?:was|has been) deleted\b/i.test(normalized)) return "deleted";
  if (/\bpost (?:was|has been) removed\b/i.test(normalized) || /\bremoved by (?:the )?moderators\b/i.test(normalized)) return "removed";
  if (/\bcontent is no longer available\b/i.test(normalized)) return "unavailable";
  return undefined;
}

type NormalizedRedditRule = {
  short_name: string;
  description: string;
  kind: "all" | "link" | "comment";
  priority: number;
};

export function formatSubredditRulesPayload(payload: unknown): { text: string; rules: NormalizedRedditRule[] } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const rawRules = (payload as { rules?: unknown }).rules;
  if (!Array.isArray(rawRules)) return undefined;

  const rules = rawRules.map((raw, index): NormalizedRedditRule | undefined => {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    const short_name = String(item.short_name ?? "").replace(/\s+/g, " ").trim();
    const description = String(item.description ?? "").replace(/\r/g, "").trim();
    const rawKind = String(item.kind ?? "all").toLowerCase();
    const kind: NormalizedRedditRule["kind"] = rawKind === "link" || rawKind === "comment" ? rawKind : "all";
    const rawPriority = typeof item.priority === "number" || typeof item.priority === "string" ? Number(item.priority) : Number.NaN;
    const priority = Number.isFinite(rawPriority) ? rawPriority : index;
    if (!short_name && !description) return undefined;
    return { short_name, description, kind, priority };
  }).filter((rule): rule is NormalizedRedditRule => Boolean(rule)).sort((a, b) => a.priority - b.priority);

  if (!rules.length) return { text: "Community Rules\nNo subreddit-specific rules are listed.", rules: [] };

  const scopeText = (kind: NormalizedRedditRule["kind"]): string => {
    if (kind === "link") return "Posts";
    if (kind === "comment") return "Comments";
    return "Posts & comments";
  };
  const text = `Community Rules\n\n${rules.map((rule, index) => [
    `${index + 1}. ${rule.short_name || "Rule"}`,
    `Applies to: ${scopeText(rule.kind)}`,
    rule.description,
  ].filter(Boolean).join("\n")).join("\n\n")}`.slice(0, 40_000);
  return { text, rules };
}

export function canonicalRedditPublishedPostUrl(currentUrl: string, subreddit: string): { url: string; fullname: string } | undefined {
  if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) return undefined;
  let u: URL;
  try { u = new URL(currentUrl); } catch { return undefined; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(host)) return undefined;

  const direct = u.pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]+)(?:\/[^/]+)?\/?$/i);
  if (direct) {
    return {
      url: `https://www.reddit.com/r/${direct[1]}/comments/${direct[2]}/`,
      fullname: `t3_${direct[2]}`,
    };
  }

  const created = (u.searchParams.get("created") ?? u.searchParams.get("createdPost") ?? "").match(/^t3_([a-z0-9]+)$/i);
  if (!created) return undefined;
  return {
    url: `https://www.reddit.com/r/${subreddit}/comments/${created[1]}/`,
    fullname: `t3_${created[1]}`,
  };
}

const ui = {
  login: [/log in/i, /увійти/i, /войти/i],
  post: [/^post$/i, /^опублікувати$/i, /^опубликовать$/i],
  comment: [/^comment$/i, /^reply$/i, /^коментувати$/i, /^відповісти$/i, /^комментировать$/i, /^ответить$/i],
  save: [/^save$/i, /^зберегти$/i, /^сохранить$/i],
  edit: [/^edit$/i, /редагувати/i, /изменить/i],
  delete: [/^delete$/i, /видалити/i, /удалить/i],
  more: [/more options/i, /more actions/i, /overflow/i, /додаткові дії/i, /інші параметри/i, /другие действия/i, /ещё/i],
  flair: [/add flair/i, /post flair/i, /^flair$/i, /додати flair/i, /выбрать flair/i],
};

export class RedditBrowserAdapter implements Adapter {
  readonly id = "reddit";
  private chrome: ExternalChrome;
  private previews = new Map<string, PreviewSession>();
  private previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rulesCache = new Map<string, CacheEntry>();
  private flairsCache = new Map<string, CacheEntry>();
  private leanPages = new WeakSet<Page>();
  private leanStates = new WeakMap<Page, LeanState>();

  constructor(private config: Config) { this.chrome = new ExternalChrome(config, "reddit"); }

  async validate(d: Draft): Promise<void> {
    if (d.action === "create_post") {
      if (!d.target.subreddit || !String(d.content.title ?? "").trim()) throw new Error("subreddit and title are required");
      this.subreddit(String(d.target.subreddit));
      const media = this.mediaFiles(d);
      if (media.length && d.content.url) throw new PublisherError("REDDIT_POST_TYPE_CONFLICT","A Reddit post cannot contain both uploaded images and a link URL.");
    } else if (d.action === "create_comment") {
      if (!d.target.url || !String(d.content.body ?? "").trim()) throw new Error("An exact Reddit permalink and body are required");
      this.permalink(String(d.target.url));
    } else if (["edit", "delete"].includes(d.action)) {
      if (!d.target.url) throw new Error("An exact Reddit publication permalink is required for edit/delete");
      this.permalink(String(d.target.url));
      if (d.action === "edit" && !String(d.content.body ?? "").trim()) throw new Error("body is required for edit");
    } else throw new Error(`Unsupported Reddit action: ${d.action}`);
  }

  async login(account: string): Promise<Record<string, unknown>> {
    const page = await this.page(account, false);
    const loginPin = `login:${account}`;
    try {
      await this.gotoRetry(page, "https://www.reddit.com/");
      this.assertOrigin(page.url());
      const authenticated = await this.cookieAuthenticated(page) && !await this.gate(page);
      if (authenticated) {
        this.chrome.unpin(account, loginPin);
        return { status: "ALREADY_AUTHENTICATED", backend: "browser", account, current_url: page.url(), note: "Persistent authenticated Reddit profile is already available; VNC is not required." };
      }
      await this.gotoRetry(page, "https://www.reddit.com/login/");
      this.chrome.pin(account, loginPin, this.config.approvalTtlSeconds);
      return { status: "USER_ACTION_REQUIRED", backend: "browser", account, current_url: page.url(),
        takeover: { client: "Any VNC viewer", address: "localhost:5901", tunnel: "ssh -N -L 5901:127.0.0.1:5901 YOUR_SERVER" },
        instructions: "Open the owner-controlled browser session (for example through a localhost-only VNC tunnel), then complete login/2FA/CAPTCHA in Chrome. Never send credentials through the publisher." };
    } finally {
      this.chrome.release(account);
    }
  }

  async status(account: string): Promise<Record<string, unknown>> {
    const page = await this.page(account, true);
    try {
      const hasSession = await this.cookieAuthenticated(page);
      const current = page.url();
      if (hasSession && this.isRedditPage(current) && !current.includes("/login")) {
        const gate = await this.gate(page);
        const authenticated = !gate;
        const username = authenticated ? await this.detectUsername(page) : undefined;
        if (authenticated) this.chrome.unpin(account, `login:${account}`);
        return { backend: "browser", authenticated, account, username, current_url: current,
          note: gate ?? "Persistent authenticated Reddit profile is available." };
      }
      if (hasSession) {
        this.chrome.unpin(account, `login:${account}`);
        return { backend: "browser", authenticated: true, account, current_url: current,
          verification: "persistent_session_cookie", note: "Persistent Reddit session cookies are present. The next real operation will verify the live UI." };
      }
      await this.gotoRetry(page, "https://www.reddit.com/");
      this.assertOrigin(page.url());
      const gate = await this.gate(page);
      const authenticated = await this.cookieAuthenticated(page) && !gate;
      const username = authenticated ? await this.detectUsername(page) : undefined;
      if (authenticated) this.chrome.unpin(account, `login:${account}`);
      return { backend: "browser", authenticated, account, username, current_url: page.url(),
        note: gate ?? "Persistent authenticated Reddit profile is available." };
    } finally {
      this.chrome.release(account);
    }
  }

  async rules(account: string, subreddit: string): Promise<unknown> {
    const sub = this.subreddit(subreddit);
    const cacheKey = `${account}:${sub.toLowerCase()}`;
    const cached = this.cacheGet(this.rulesCache, cacheKey);
    if (cached) return cached;

    const page = await this.page(account, true);
    try {
      if (!this.isRedditPage(page.url())) {
        await this.gotoRetry(page, "https://www.reddit.com/");
        this.assertOrigin(page.url());
      }
      await this.requireAuth(page);

      const response = await page.evaluate(async (subredditName) => {
        const api = await fetch(`/r/${encodeURIComponent(subredditName)}/about/rules.json?raw_json=1`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        return {
          status: api.status,
          url: api.url,
          text: (await api.text()).slice(0, 100_000),
        };
      }, sub);

      if (response.status === 401 || response.status === 403) {
        throw new Error("TAKEOVER_REQUIRED: Reddit rules API rejected the authenticated browser session");
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`REDDIT_RULES_API_FAILED: Reddit rules API returned HTTP ${response.status}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.text);
      } catch {
        throw new Error("SITE_CHANGED: Reddit rules API returned non-JSON content");
      }
      const formatted = formatSubredditRulesPayload(payload);
      if (!formatted) throw new Error("SITE_CHANGED: Reddit rules API returned an unexpected payload");

      const value = {
        backend: "browser",
        subreddit: sub,
        url: response.url,
        text: formatted.text,
        rules: formatted.rules,
        cached: false,
        fetched_at: new Date().toISOString(),
      };
      this.cacheSet(this.rulesCache, cacheKey, value);
      return value;
    } finally {
      this.chrome.release(account);
    }
  }

  async flairs(account: string, subreddit: string): Promise<unknown> {
    const sub = this.subreddit(subreddit);
    const cacheKey = `${account}:${sub.toLowerCase()}`;
    const cached = this.cacheGet(this.flairsCache, cacheKey);
    if (cached) return cached;

    const page = await this.page(account, true);
    try {
      await page.goto(`https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?type=TEXT`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.assertOrigin(page.url());
      await this.requireAuth(page);
      // Reddit hydrates the flair web component after the title and Post controls.
      // Wait for that semantic control before concluding flair is unsupported.
      const trigger = await this.waitForAny(page, ["button", "combobox"], ui.flair, 20);
      if (!trigger) {
        const expectedPath = `/r/${sub}/submit`;
        const onComposer = new URL(page.url()).pathname.toLowerCase().startsWith(expectedPath.toLowerCase());
        const title = await this.needUniqueTextbox(page, [/title/i, /заголов/i]).catch(() => undefined);
        const post = await this.findAny(page, ["button"], ui.post);
        if (onComposer && title && post) {
          const value = { backend: "browser", subreddit: sub, flairs: [], flair_supported: false, cached: false, fetched_at: new Date().toISOString() };
          this.cacheSet(this.flairsCache, cacheKey, value);
          return value;
        }
        throw new Error("SITE_CHANGED: no semantic flair control or verified Reddit composer found");
      }
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      const label = `${await trigger.innerText().catch(() => "")} ${await trigger.getAttribute("aria-label").catch(() => "") ?? ""}`;
      const value = { backend: "browser", subreddit: sub, flairs: await this.readFlairOptions(page), flair_supported: true,
        flair_required: /\*|required/i.test(label), cached: false, fetched_at: new Date().toISOString() };
      this.cacheSet(this.flairsCache, cacheKey, value);
      return value;
    } finally {
      this.chrome.release(account);
    }
  }

  async preview(d: Draft): Promise<PreviewData> {
    const page = await this.page(d.account, true);
    try {
      let session: PreviewSession;
      if (d.action === "create_post") session = await this.previewPost(page, d);
      else if (d.action === "create_comment") session = await this.previewComment(page, d);
      else session = await this.previewOwnMutation(page, d);
      const artifact = await this.shot(page, d.id);
      this.rememberPreview(d, session);
      const content = d.action === "delete" ? {} : { ...d.content };
      if (Array.isArray(content.media_files)) content.media_files = (content.media_files as MediaFile[]).map(file=>({name:file.name,mime_type:file.mime_type,size:file.size,sha256:file.sha256}));
      return { summary: { backend: "browser", action: d.action, account: d.account, target: d.target, target_identity: session.targetIdentity,
        content, current_url: page.url(), notice: "The exact Reddit form is ready; no Post/Comment/Save/Delete action was clicked." }, artifact_path: artifact };
    } finally {
      this.chrome.release(d.account);
    }
  }

  approved(d: Draft): void {
    const session = this.previews.get(d.id);
    if (!session) return;
    this.chrome.pin(d.account, this.previewPin(d.id), this.config.approvalTtlSeconds);
    this.schedulePreviewExpiry(d.id, session, this.config.approvalTtlSeconds);
  }

  async publish(d: Draft): Promise<PublishData> {
    const pin = this.previewPin(d.id);
    try {
      const s = this.previews.get(d.id);
      if (!s || s.page.isClosed()) throw new Error("APPROVAL_STALE: Reddit browser preview no longer exists; create a new preview and approval");
      if (s.action !== d.action || s.page.url() !== s.pageUrl) throw new Error("APPROVAL_STALE: Reddit page/action changed after preview");
      this.assertOrigin(s.page.url());
      await this.verifyForm(s);
      const before = s.page.url();
      if (d.action === "delete") {
        if (!s.deleteControl || !await s.deleteControl.isVisible()) throw new Error("APPROVAL_STALE: exact Delete control disappeared");
        await s.deleteControl.click();
        const confirm = await this.needUniqueAny(s.page, ["button"], ui.delete);
        await confirm.click();
        await s.targetScope.waitFor({ state: "detached", timeout: 20_000 }).catch(() => { throw new Error("PUBLISH_RESULT_AMBIGUOUS: exact Reddit target did not disappear after delete"); });
      } else {
        if (!s.submit || !await s.submit.isVisible()) throw new Error("APPROVAL_STALE: exact submit control disappeared");
        await s.submit.click();
        if (d.action === "create_post") await this.waitPostCommitted(s, before);
        else if (s.bodyField) await this.waitComposerCommitted(s.bodyField);
      }
      const errors = await s.page.getByRole("alert").allTextContents().catch(() => []);
      if (errors.some(x => x.trim())) throw new Error(`PUBLISH_RESULT_AMBIGUOUS: Reddit alert: ${errors.join(" | ").slice(0, 300)}`);
      if (d.action === "create_post") {
        const canonical = canonicalRedditPublishedPostUrl(s.page.url(), String(d.target.subreddit));
        if (!canonical) {
          return { status: "PUBLISHED", warnings: ["Reddit published the post, but the browser did not expose a canonical post permalink. The non-canonical browser URL was intentionally not returned."] };
        }
        return { status: "PUBLISHED", external_id: canonical.fullname, url: canonical.url, warnings: [] };
      }
      return { status: "PUBLISHED", url: s.page.url(), warnings: [] };
    } finally {
      this.forgetPreview(d.id);
      this.chrome.unpin(d.account, pin);
    }
  }

  async diagnose(live: boolean): Promise<Record<string, unknown>> {
    const chrome = fs.existsSync(this.config.chromePath);
    if (!live) return { adapter: this.id, backend: "browser", chrome_exists: chrome, display: this.config.display,
      browser_idle_seconds: this.config.browserIdleSeconds ?? 90, metadata_cache_seconds: this.config.redditMetadataCacheSeconds ?? 900 };
    const page = await this.page("default", true);
    try {
      await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.assertOrigin(page.url());
      const gate = await this.gate(page);
      return { adapter: this.id, backend: "browser", chrome_exists: chrome, reddit_reachable: !gate, title: await page.title(), authenticated: !gate, requires_user_action: gate };
    } catch (e: any) {
      return { adapter: this.id, backend: "browser", chrome_exists: chrome, reddit_reachable: false, error: e.message };
    } finally {
      this.chrome.release("default");
    }
  }

  private async previewPost(page: Page, d: Draft): Promise<PreviewSession> {
    const sub = this.subreddit(String(d.target.subreddit));
    const media = this.mediaFiles(d);
    const requested = `https://www.reddit.com/r/${encodeURIComponent(sub)}/submit?type=${media.length ? "IMAGE" : d.content.url ? "LINK" : "TEXT"}`;
    await page.goto(requested, { waitUntil: "domcontentloaded", timeout: 30_000 });
    this.assertOrigin(page.url());
    await this.requireAuth(page);
    if (!new URL(page.url()).pathname.startsWith(`/r/${sub}/submit`)) throw new PublisherError("SUBREDDIT_RESTRICTED", `Reddit did not open the post form for r/${sub} and redirected to ${page.url()}. The community may be private, approval-only, or unavailable to this account; no post was filled or published.`, { subreddit: sub, requested_url: requested, current_url: page.url(), requested_action: "create_post" });
    const pageText = (await page.locator("body").innerText().catch(() => "")).slice(0, 5000);
    if (/this is a private community|only approved members can view and contribute|request to join/i.test(pageText)) throw new PublisherError("SUBREDDIT_RESTRICTED", `r/${sub} is a private or approval-only community. Reddit did not provide a post form, so no draft was filled or published. Choose another subreddit or get the account approved first.`, { subreddit: sub, requested_action: "create_post" });
    const titleField = await this.needUniqueTextbox(page, [/title/i, /заголов/i]);
    await titleField.fill(String(d.content.title));
    let bodyField: Locator | undefined, linkField: Locator | undefined, flairControl: Locator | undefined, mediaScope: Locator | undefined;
    if (media.length) {
      const mediaInput = await this.imageFileInput(page);
      if (media.length > 1 && await mediaInput.getAttribute("multiple") === null) throw new PublisherError("REDDIT_MEDIA_LIMIT","The current Reddit image form accepts only one file for this community/post type. Nothing was published.",{subreddit:sub,requested_images:media.length});
      await mediaInput.setInputFiles(media.map(file=>file.path));
      mediaScope=page.locator('r-post-media-input#post-composer_media');
      await mediaScope.getByRole("button",{name:/remove media/i}).waitFor({state:"visible",timeout:30_000})
        .catch(()=>{throw new Error("SITE_CHANGED: Reddit did not render the selected image preview");});
      if (d.content.body) {
        bodyField = await this.needUniqueTextbox(page, [/body/i, /^text$/i, /текст/i, /caption/i], titleField)
          .catch(()=>{throw new PublisherError("SUBREDDIT_FORMAT_CONSTRAINT",`The current Reddit image-post form for r/${sub} does not expose body text. The images and title were filled, but nothing was published; remove the body or add it later as a comment.`,{subreddit:sub,requested_action:"create_post",constraint:"image_post_without_body"});});
        await bodyField.fill(String(d.content.body));
      }
    } else if (d.content.url) {
      linkField = await this.needUniqueTextbox(page, [/url/i, /посилання/i, /ссылк/i]);
      await linkField.fill(String(d.content.url));
    } else if (d.content.body) {
      try {
        bodyField = await this.needUniqueTextbox(page, [/body/i, /^text$/i, /текст/i], titleField);
        await bodyField.fill(String(d.content.body));
      } catch (e) {
        if (/may not use the body textbox|не можна використовувати поле body|не используйте поле body/i.test(pageText)) throw new PublisherError("SUBREDDIT_FORMAT_CONSTRAINT", `r/${sub} does not allow a body textbox for this post type. The requested body was not filled and nothing was published; use a title-only post or choose another subreddit.`, { subreddit: sub, requested_action: "create_post", constraint: "title_only" });
        throw e;
      }
    }
    const requiredFlair = await this.findAny(page, ["button", "combobox"], [/add flair.*\*/i, /flair.*required/i, /додати flair.*\*/i]);
    if (requiredFlair && !d.content.flair) {
      await requiredFlair.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      const flairs = await this.readFlairOptions(page);
      await page.keyboard.press("Escape").catch(() => undefined);
      throw new PublisherError("SUBREDDIT_FLAIR_REQUIRED", `r/${sub} requires a post flair. No post was published; choose one of the available flair options and prepare a new draft.`,
        { subreddit: sub, requested_action: "create_post", reason: "required_flair", flairs });
    }
    if (d.content.flair) flairControl = await this.chooseFlair(page, String(d.content.flair));
    const form = await this.formFor(page, titleField);
    const submit = await this.needUniqueAny(form, ["button"], ui.post);
    if (media.length) await this.waitEnabled(submit,30_000,"SITE_CHANGED: Reddit did not finish preparing the selected image upload");
    const scope = page.locator("main");
    return { page, action: d.action, pageUrl: page.url(), targetIdentity: `r/${sub}`, targetScope: scope, submit, titleField, bodyField, linkField,
      title: String(d.content.title), body: d.content.body ? String(d.content.body) : undefined, outboundUrl: d.content.url ? String(d.content.url) : undefined,
      flair: d.content.flair ? String(d.content.flair) : undefined, flairControl, mediaScope };
  }

  private async previewComment(page: Page, d: Draft): Promise<PreviewSession> {
    const id = this.permalink(String(d.target.url));
    await page.goto(id.permalink, { waitUntil: "domcontentloaded", timeout: 30_000 });
    this.assertOrigin(page.url());
    await this.requireAuth(page);
    this.assertSameTarget(page.url(), id);
    await this.requireTargetAvailable(page, id);
    const scope = await this.targetScope(page, id);
    let bodyField: Locator;
    if (id.commentId) {
      const reply = await this.needUniqueAny(scope, ["button"], ui.comment);
      await reply.click();
      bodyField = await this.needUniqueTextbox(scope, [/comment/i, /reply/i, /коментар/i, /відповід/i, /ответ/i])
        .catch(() => this.needUniqueTextbox(page, [/comment/i, /reply/i, /коментар/i, /відповід/i, /ответ/i]));
    } else {
      const composer = await this.postCommentComposer(page, id);
      bodyField = await this.needUniqueTextbox(composer, [/comment/i, /reply/i, /коментар/i, /відповід/i, /ответ/i]);
    }
    await bodyField.fill(String(d.content.body));
    const form = await this.formFor(page, bodyField);
    const submit = await this.commentSubmit(form);
    return { page, action: d.action, pageUrl: page.url(), targetIdentity: id.fullname, targetScope: scope, submit, bodyField, body: String(d.content.body) };
  }

  private async previewOwnMutation(page: Page, d: Draft): Promise<PreviewSession> {
    const id = this.permalink(String(d.target.url));
    await page.goto(id.permalink, { waitUntil: "domcontentloaded", timeout: 30_000 });
    this.assertOrigin(page.url());
    await this.requireAuth(page);
    this.assertSameTarget(page.url(), id);
    await this.requireTargetAvailable(page, id);
    const scope = await this.targetScope(page, id);
    await this.openOwnActions(scope, d.action);
    if (d.action === "delete") {
      const del = await this.needUniqueAny(scope, ["button", "menuitem"], ui.delete);
      return { page, action: d.action, pageUrl: page.url(), targetIdentity: id.fullname, targetScope: scope, deleteControl: del };
    }
    const edit = await this.needUniqueAny(scope, ["button", "menuitem"], ui.edit);
    await edit.click();
    const bodyField = await this.needUniqueTextbox(scope, [/body/i, /text/i, /comment/i, /текст/i]);
    await bodyField.fill(String(d.content.body));
    const form = await this.formFor(page, bodyField);
    const submit = await this.needUniqueAny(form, ["button"], ui.save);
    return { page, action: d.action, pageUrl: page.url(), targetIdentity: id.fullname, targetScope: scope, submit, bodyField, body: String(d.content.body) };
  }

  private async verifyForm(s: PreviewSession): Promise<void> {
    if (!await s.targetScope.isVisible().catch(() => false)) throw new Error("APPROVAL_STALE: exact Reddit target is no longer visible");
    if (s.titleField && await s.titleField.inputValue() !== s.title) throw new Error("APPROVAL_STALE: title changed after preview");
    if (s.bodyField && await this.fieldValue(s.bodyField) !== s.body) throw new Error("APPROVAL_STALE: body/comment changed after preview");
    if (s.linkField && await s.linkField.inputValue() !== s.outboundUrl) throw new Error("APPROVAL_STALE: outbound URL changed after preview");
    if (s.mediaScope && (!await s.mediaScope.isVisible().catch(()=>false) || !await s.mediaScope.getByRole("button",{name:/remove media/i}).isVisible().catch(()=>false))) throw new Error("APPROVAL_STALE: selected Reddit images disappeared after preview");
    if (s.flair && !s.flairControl) throw new Error("APPROVAL_STALE: flair control disappeared after preview");
  }

  private async openOwnActions(scope: Locator, action: Draft["action"]): Promise<void> {
    const desired = action === "edit" ? ui.edit : ui.delete;
    if (await this.findAny(scope, ["button", "menuitem"], desired)) return;
    const menu = await this.needUniqueAny(scope, ["button"], ui.more);
    await menu.click();
    if (!await this.findAny(scope, ["button", "menuitem"], desired)) throw new Error("OWNERSHIP_UNVERIFIED: requested action is unavailable in the exact target container");
  }

  private async chooseFlair(page: Page, name: string): Promise<Locator> {
    const trigger = await this.needUniqueAny(page, ["button", "combobox"], ui.flair);
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const all = await this.findAny(page, ["button"], [/view all flairs/i, /показати всі flair/i]);
    if (all) await all.click();
    let choice: Locator | undefined;
    for (let attempt = 0; attempt < 20 && !choice; attempt += 1) {
      const radios = page.locator('[role="radio"]');
      for (let i = 0; i < await radios.count(); i += 1) {
        const item = radios.nth(i);
        if (!await item.isVisible().catch(() => false)) continue;
        const label = ((await item.innerText().catch(() => "")) || await item.getAttribute("aria-label").catch(() => null) || "").trim();
        if (label.toLocaleLowerCase() === name.trim().toLocaleLowerCase()) { choice = item; break; }
      }
      if (!choice) {
        const text = page.getByText(name, { exact: true });
        for (let i = 0; i < await text.count(); i += 1) {
          const item = text.nth(i);
          if (await item.isVisible().catch(() => false)) { choice = item; break; }
        }
      }
      if (!choice) await page.waitForTimeout(500);
    }
    if (!choice) throw new Error("SITE_CHANGED: requested flair not found in Reddit picker");
    await choice.click();
    const adds = page.getByRole("button", { name: /^add$/i });
    let apply: Locator | undefined;
    for (let i = 0; i < await adds.count(); i += 1) if (await adds.nth(i).isVisible().catch(() => false)) apply = adds.nth(i);
    if (apply) await apply.click();
    return trigger;
  }

  private mediaFiles(d: Draft): MediaFile[] {
    const raw=d.content.media_files;
    if (raw===undefined) return [];
    if (!Array.isArray(raw) || raw.length<1 || raw.length>4) throw new PublisherError("REDDIT_MEDIA_INVALID","Reddit image posts require between one and four prepared images.");
    const roots=["gpt-files","local-files"].map(name=>path.resolve(this.config.stateDir,"artifacts",name)+path.sep);
    return raw.map((value,index)=>{
      if(!value || typeof value!=="object" || Array.isArray(value))throw new PublisherError("REDDIT_MEDIA_INVALID",`Image ${index+1} metadata is invalid.`);
      const file=value as Record<string,unknown>; const requested=String(file.path??"");
      let resolved:string;
      try{resolved=fs.realpathSync(requested);}catch{throw new PublisherError("REDDIT_MEDIA_MISSING",`Prepared image ${index+1} is no longer available. Attach it again and create a fresh preview.`);}
      if(!roots.some(root=>resolved.startsWith(root)))throw new PublisherError("REDDIT_MEDIA_FORBIDDEN","Reddit image files must come from a protected publisher media directory.");
      const stat=fs.statSync(resolved); if(!stat.isFile() || stat.size<1 || stat.size>20*1024*1024)throw new PublisherError("REDDIT_MEDIA_INVALID",`Prepared image ${index+1} has an invalid size.`);
      const mime=String(file.mime_type??""); if(!["image/png","image/jpeg","image/gif","image/webp"].includes(mime))throw new PublisherError("REDDIT_MEDIA_INVALID",`Prepared image ${index+1} has an unsupported type.`);
      return {path:resolved,name:String(file.name??path.basename(resolved)),mime_type:mime,size:stat.size,sha256:String(file.sha256??"")};
    });
  }

  private async imageFileInput(page: Page): Promise<Locator> {
    const pick=async():Promise<Locator|undefined>=>{
      const labeled=page.getByLabel(/upload|image|photo|зображ|фото|изображ/i);
      for(let i=0;i<await labeled.count();i+=1)if(await labeled.nth(i).getAttribute("type")==="file")return labeled.nth(i);
      const files=page.locator('input[type="file"]');
      const imageCandidates:Locator[]=[]; const primaryCandidates:Locator[]=[];
      for(let i=0;i<await files.count();i+=1){
        const item=files.nth(i);const accept=(await item.getAttribute("accept")??"").toLowerCase();if(accept&&!accept.includes("image"))continue;
        imageCandidates.push(item);
        const primary=await item.evaluate(element=>{
          let current:Element|null=element;let mediaHost=false;
          for(let depth=0;current&&depth<8;depth+=1){
            if(current.tagName==="EDIT-GALLERY-MODAL" || current.tagName==="RTE-TOOLBAR-BUTTON-IMAGE")return false;
            if(current.tagName==="R-POST-MEDIA-INPUT" && current.id==="post-composer_media")mediaHost=true;
            const root=current.getRootNode();current=current.parentElement||(root instanceof ShadowRoot?root.host:null);
          }
          return mediaHost;
        });
        if(primary&&accept.includes("video"))primaryCandidates.push(item);
      }
      if(primaryCandidates.length===1)return primaryCandidates[0];
      if(primaryCandidates.length>1)throw new Error(`AMBIGUOUS_TARGET: expected one primary Reddit media input, found ${primaryCandidates.length}`);
      if(imageCandidates.length===1)return imageCandidates[0];
      if(imageCandidates.length>1)throw new Error(`AMBIGUOUS_TARGET: expected one semantic image file input, found ${imageCandidates.length}`);
      return undefined;
    };
    let input=await pick(); if(input)return input;
    const tab=await this.findAny(page,["tab","button"],[/images?\s*(?:&|and)?\s*video/i,/image post/i,/зображення/i,/изображения/i]);
    if(tab){await tab.click();await page.waitForTimeout(500);input=await pick();}
    if(!input)throw new Error("SITE_CHANGED: Reddit image upload control was not found");
    return input;
  }

  private async waitEnabled(control:Locator,timeoutMs:number,message:string):Promise<void>{
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){if(await control.isEnabled().catch(()=>false))return;await control.page().waitForTimeout(500);}
    throw new Error(message);
  }

  private async requireTargetAvailable(page: Page, id: TargetIdentity): Promise<void> {
    const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 20_000);
    const reason = detectRedditTargetUnavailableText(bodyText);
    if (!reason) return;
    throw new PublisherError(
      "REDDIT_TARGET_UNAVAILABLE",
      `The Reddit target ${id.fullname} is unavailable (${reason.replace(/_/g, " ")}). It may have been deleted, removed, or the link may be stale. Nothing was published.`,
      { target_fullname: id.fullname, target_url: id.permalink, current_url: page.url(), reason },
    );
  }

  private async targetScope(page: Page, id: TargetIdentity): Promise<Locator> {
    const selectors = id.commentId
      ? [`shreddit-comment[thingid="${id.fullname}"]`, `shreddit-comment[id="${id.fullname}"]`, `[data-fullname="${id.fullname}"]`]
      : [`shreddit-post[id="${id.fullname}"]`, `shreddit-post[thingid="${id.fullname}"]`, `[data-fullname="${id.fullname}"]`];
    // Reddit's post-detail shell can finish DOMContentLoaded before the exact
    // shreddit-post/comment container is hydrated. Retry the same strict,
    // identity-bound selectors instead of treating that normal delay as a UI
    // change or falling back to a page-wide guess.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const selector of selectors) {
        const x = page.locator(selector);
        const n = await this.visibleCount(x);
        if (n === 1) return x.filter({ visible: true }).first();
        if (n > 1) throw new Error(`AMBIGUOUS_TARGET: multiple containers for ${id.fullname}`);
      }
      if (attempt < 19) await page.waitForTimeout(500);
    }
    throw new Error(`SITE_CHANGED: exact semantic container ${id.fullname} not found`);
  }

  private permalink(value: string): TargetIdentity {
    const u = new URL(value);
    this.assertOrigin(u.toString());
    const m = u.pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?\/?$/i);
    if (!m) throw new Error("Reddit mutation target must be a canonical post/comment permalink");
    const commentId = m[3];
    return { subreddit: m[1], postId: m[2], commentId, fullname: commentId ? `t1_${commentId}` : `t3_${m[2]}`, permalink: `https://www.reddit.com${u.pathname}` };
  }

  private assertSameTarget(actual: string, expected: TargetIdentity): void {
    const got = this.permalink(actual);
    if (got.fullname !== expected.fullname) throw new Error("AMBIGUOUS_TARGET: Reddit redirected to a different publication");
  }

  private assertOrigin(value: string): void {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || !["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(h)) throw new Error("Only canonical HTTPS Reddit URLs are allowed");
  }

  private subreddit(value: string): string {
    const s = value.replace(/^r\//, "");
    if (!/^[A-Za-z0-9_]{2,21}$/.test(s)) throw new Error("Invalid subreddit name");
    return s;
  }

  private async page(account: string, lean: boolean): Promise<Page> {
    const page = await this.chrome.page(account);
    let state = this.leanStates.get(page);
    if (!state) {
      state = { enabled: lean };
      this.leanStates.set(page, state);
    } else state.enabled = lean;

    if (!this.leanPages.has(page)) {
      const captured = state;
      await page.route("**/*", async route => {
        const request = route.request();
        const type = request.resourceType();
        if (captured.enabled && ["image", "media", "font"].includes(type) && this.isRedditAsset(request.url())) {
          await route.abort().catch(() => undefined);
          return;
        }
        await route.continue().catch(() => undefined);
      });
      this.leanPages.add(page);
    }
    return page;
  }

  private isRedditAsset(value: string): boolean {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === "reddit.com" || host.endsWith(".reddit.com") || host === "redditmedia.com" || host.endsWith(".redditmedia.com") ||
        host === "redditstatic.com" || host.endsWith(".redditstatic.com") || host === "redd.it" || host.endsWith(".redd.it");
    } catch { return false; }
  }

  private isRedditPage(value: string): boolean {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(host);
    } catch { return false; }
  }

  private async gate(page: Page): Promise<string | undefined> {
    const title = (await page.title()).trim();
    const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 3000);
    if (page.url().includes("/login") || await this.anyVisible(page, ["link", "button"], ui.login)) return "AUTH_REQUIRED: complete manual Reddit login via VNC";
    if (/^blocked$/i.test(title) || /blocked by network security|whoa there|request has been blocked/i.test(text)) return "TAKEOVER_REQUIRED: Reddit presented a network-security/CAPTCHA gate; inspect it via VNC";
    if (!title && !text.trim()) return "TAKEOVER_REQUIRED: Reddit returned an empty browser shell; inspect login/consent via VNC";
    return undefined;
  }

  private async requireAuth(page: Page): Promise<void> {
    const gate = await this.gate(page);
    if (gate) throw new Error(gate);
  }

  private async gotoRetry(page: Page, url: string): Promise<void> {
    let last: unknown;
    for (let i = 0; i < 3; i += 1) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return;
      } catch (e: any) {
        last = e;
        if (!String(e.message).includes("ERR_CERT_VERIFIER_CHANGED")) throw e;
        await page.waitForTimeout(750);
      }
    }
    throw last;
  }

  private async anyVisible(scope: Page | Locator, roles: Role[], names: RegExp[]): Promise<boolean> { return Boolean(await this.findAny(scope, roles, names)); }
  private async readFlairOptions(page: Page): Promise<string[]> {
    let latest: string[] = [];
    let stableRounds = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const radios = await page.getByRole("radio").allTextContents().catch(() => []);
      const options = radios.length ? [] : await page.getByRole("option").allTextContents().catch(() => []);
      const values = normalizeFlairOptions([...radios, ...options]);
      if (values.length && JSON.stringify(values) === JSON.stringify(latest)) stableRounds += 1;
      else { latest = values; stableRounds = 0; }
      // Require multiple stable reads because Reddit appends flair rows lazily.
      if (latest.length && stableRounds >= 2) return latest;
      if (attempt < 19) await page.waitForTimeout(500);
    }
    return latest;
  }
  private async waitForAny(scope: Page | Locator, roles: Role[], names: RegExp[], attempts: number): Promise<Locator | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const found = await this.findAny(scope, roles, names);
      if (found) return found;
      if (attempt < attempts - 1) await ("page" in scope ? scope.page() : scope).waitForTimeout(500);
    }
    return undefined;
  }
  private async findAny(scope: Page | Locator, roles: Role[], names: RegExp[]): Promise<Locator | undefined> {
    for (const role of roles) for (const name of names) {
      const x = scope.getByRole(role as any, { name });
      if (await this.visibleCount(x)) return x.filter({ visible: true }).first();
    }
    return undefined;
  }

  private async needUniqueAny(scope: Page | Locator, roles: Role[], names: RegExp[]): Promise<Locator> {
    for (const role of roles) for (const name of names) {
      const x = scope.getByRole(role as any, { name });
      const n = await this.visibleCount(x);
      if (n === 1) return x.filter({ visible: true }).first();
      if (n > 1) throw new Error(`AMBIGUOUS_TARGET: expected one semantic ${role}, found ${n}`);
    }
    throw new Error("SITE_CHANGED: expected semantic control not found");
  }

  private async needUniqueTextbox(scope: Page | Locator, names: RegExp[], exclude?: Locator): Promise<Locator> {
    const joined = names.map(String).join(" ");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidates: Locator[] = [];
      for (const name of names) candidates.push(scope.getByRole("textbox", { name }), scope.getByLabel(name), scope.getByPlaceholder(name));
      if (/title|заголов/i.test(joined)) candidates.push(scope.locator('input[name="title"],textarea[name="title"]'));
      if (/body|text|comment|комментар|коментар|текст/i.test(joined)) candidates.push(scope.locator('textarea[name="body"],textarea[name="textarea"],[data-lexical-editor="true"],[contenteditable="true"]'));
      for (const x of candidates) {
        const visible: Locator[] = [];
        for (let i = 0; i < await x.count(); i += 1) {
          const item = x.nth(i);
          if (!await item.isVisible().catch(() => false)) continue;
          if (exclude && await item.evaluate((e, other) => e === other, await exclude.elementHandle())) continue;
          visible.push(item);
        }
        if (visible.length === 1) return visible[0];
        if (visible.length > 1) throw new Error(`AMBIGUOUS_TARGET: expected one semantic textbox, found ${visible.length}`);
      }
      if (attempt < 19) await ("page" in scope ? scope.page() : scope).waitForTimeout(500);
    }
    throw new Error("SITE_CHANGED: expected semantic textbox not found");
  }

  private async postCommentComposer(page: Page, id: TargetIdentity): Promise<Locator> {
    const host = page.locator(`comment-composer-host[post-id="${id.fullname}"]`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const n = await host.count();
      if (n === 1) {
        const composer = host.first();
        const editor = composer.locator('textarea[name="body"],textarea[name="textarea"],[data-lexical-editor="true"],[contenteditable="true"]');
        if (await this.visibleCount(editor) === 0) {
          const trigger = composer.locator('faceplate-textarea-input[data-testid="trigger-button"]');
          const tn = await trigger.count();
          if (tn > 1) throw new Error(`AMBIGUOUS_TARGET: multiple top-level comment triggers for ${id.fullname}`);
          if (tn === 1) await trigger.click({ timeout: 10_000 });
        }
        return composer;
      }
      if (n > 1) throw new Error(`AMBIGUOUS_TARGET: multiple top-level comment composers for ${id.fullname}`);
      if (attempt < 19) await page.waitForTimeout(500);
    }
    throw new Error(`SITE_CHANGED: exact top-level comment composer for ${id.fullname} not found`);
  }

  private async formFor(page: Page, field: Locator): Promise<Page | Locator> {
    // New Reddit wraps comment composers in <faceplate-form>; older composer
    // variants still use native forms. Scope the submit lookup to either one.
    const forms = page.locator("form, faceplate-form").filter({ has: field });
    const n = await this.visibleCount(forms);
    if (n === 0) return page;
    if (n !== 1) throw new Error(`SITE_CHANGED: expected one semantic form for composer, found ${n}`);
    return forms.filter({ visible: true }).first();
  }

  private async commentSubmit(scope: Page | Locator): Promise<Locator> {
    // Current Reddit exposes the exact composer submit control with this slot.
    // Prefer it over a page-wide name lookup because a thread can contain many
    // visible Reply/Comment controls unrelated to the active composer.
    const slotted = scope.locator('button[slot="submit-button"]');
    const n = await this.visibleCount(slotted);
    if (n === 1) return slotted.filter({ visible: true }).first();
    if (n > 1) throw new Error(`AMBIGUOUS_TARGET: expected one Reddit comment submit control, found ${n}`);
    return this.needUniqueAny(scope, ["button"], ui.comment);
  }

  private async visibleCount(x: Locator): Promise<number> {
    let n = 0;
    for (let i = 0; i < await x.count(); i += 1) if (await x.nth(i).isVisible().catch(() => false)) n += 1;
    return n;
  }

  private async fieldValue(x: Locator): Promise<string> { return await x.inputValue().catch(async () => await x.innerText()); }
  private async waitPostCommitted(s: PreviewSession, before: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    let resetSince = 0;
    while (Date.now() < deadline) {
      if (s.page.url() !== before) return;

      const alerts = await s.page.getByRole("alert").allTextContents().catch(() => []);
      const alertText = alerts.map(x => x.trim()).filter(Boolean).join(" | ");
      if (alertText) throw new Error(`PUBLISH_RESULT_AMBIGUOUS: Reddit alert after Post: ${alertText.slice(0, 300)}`);

      // New Reddit can complete a submit in-place without changing the URL.
      // In that flow the composer is reset/unmounted after the server accepts
      // the post. Require that state to remain stable briefly so a transient
      // React re-render is not mistaken for a successful publication.
      const count = s.titleField ? await s.titleField.count().catch(() => 0) : 0;
      let reset = count === 0;
      if (!reset && s.titleField) {
        const value = await s.titleField.inputValue().catch(() => undefined);
        reset = value === "" && Boolean(s.title);
      }
      if (reset) {
        if (!resetSince) resetSince = Date.now();
        if (Date.now() - resetSince >= 500) return;
      } else {
        resetSince = 0;
      }
      await s.page.waitForTimeout(200);
    }
    throw new Error("PUBLISH_RESULT_AMBIGUOUS: Reddit did not expose a stable success signal after Post");
  }

  private async waitComposerCommitted(x: Locator): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      if (!await x.isVisible().catch(() => false) || await this.fieldValue(x) === "") return;
      await x.page().waitForTimeout(500);
    }
    throw new Error("PUBLISH_RESULT_AMBIGUOUS: exact Reddit composer did not clear or close");
  }

  private async detectUsername(page: Page): Promise<string | undefined> {
    const text = await page.locator("body").innerText().catch(() => "");
    return text.match(/u\/([A-Za-z0-9_-]{3,20})/)?.[1];
  }

  private async cookieAuthenticated(page: Page): Promise<boolean> {
    const names = (await page.context().cookies()).filter(c => c.domain.includes("reddit")).map(c => c.name);
    return names.includes("reddit_session") || names.includes("token_v2");
  }

  private previewPin(id: string): string { return `preview:${id}`; }

  private rememberPreview(d: Draft, session: PreviewSession): void {
    this.forgetPreview(d.id);
    this.previews.set(d.id, session);
    this.chrome.pin(d.account, this.previewPin(d.id), this.config.approvalTtlSeconds);
    this.schedulePreviewExpiry(d.id, session, this.config.approvalTtlSeconds);
  }

  private schedulePreviewExpiry(id: string, session: PreviewSession, ttlSeconds: number): void {
    const previous = this.previewTimers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.previews.get(id) === session) this.previews.delete(id);
      this.previewTimers.delete(id);
    }, (ttlSeconds + 5) * 1000);
    timer.unref?.();
    this.previewTimers.set(id, timer);
  }

  private forgetPreview(id: string): void {
    const timer = this.previewTimers.get(id);
    if (timer) clearTimeout(timer);
    this.previewTimers.delete(id);
    this.previews.delete(id);
  }

  private cacheGet(cache: Map<string, CacheEntry>, key: string): Record<string, unknown> | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { cache.delete(key); return undefined; }
    return { ...entry.value, cached: true, cache_age_seconds: Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000)) };
  }

  private cacheSet(cache: Map<string, CacheEntry>, key: string, value: Record<string, unknown>): void {
    const storedAt = Date.now();
    const ttl = Math.max(30, Number(this.config.redditMetadataCacheSeconds ?? 900));
    cache.set(key, { value, storedAt, expiresAt: storedAt + ttl * 1000 });
  }

  private async shot(page: Page, id: string): Promise<string> {
    const p = path.join(this.config.stateDir, "artifacts", `${id}.png`);
    await page.screenshot({ path: p, fullPage: false });
    fs.chmodSync(p, 0o600);
    return p;
  }
}

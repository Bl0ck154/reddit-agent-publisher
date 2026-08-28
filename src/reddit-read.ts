import type { Page } from "playwright-core";
import { ExternalChrome } from "./external-chrome.js";
import { detectRedditUsername } from "./reddit-identity.js";

type JsonObject = Record<string, unknown>;
type ActivityKind = "all" | "posts" | "comments";

type RedditThreadTarget = {
  subreddit: string;
  post_id: string;
  comment_id?: string;
  canonical_url: string;
};

type CommentStats = {
  returned: number;
  omitted_more: number;
  truncated: boolean;
};

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isoFromUtc(value: unknown): string | undefined {
  const seconds = number(value);
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

function redditUrl(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  if (raw.startsWith("/")) return `https://www.reddit.com${raw}`;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol === "https:" && ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(host)) return url.toString();
  } catch {
    // Invalid URLs are omitted from normalized read-only output.
  }
  return undefined;
}

function listingChildren(value: unknown): JsonObject[] {
  const listing = object(value);
  const data = object(listing?.data);
  return array(data?.children).map(object).filter((item): item is JsonObject => Boolean(item));
}

export function canonicalRedditThreadTarget(input: string): RedditThreadTarget {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(host)) {
    throw new Error("Only canonical HTTPS Reddit thread/comment URLs are allowed");
  }
  const match = url.pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?\/?$/i);
  if (!match) throw new Error("Reddit thread target must be a canonical post/comment permalink");
  const subreddit = match[1];
  const post_id = match[2].toLowerCase();
  const comment_id = match[3]?.toLowerCase();
  return {
    subreddit,
    post_id,
    comment_id,
    canonical_url: comment_id
      ? `https://www.reddit.com/r/${subreddit}/comments/${post_id}/_/${comment_id}/`
      : `https://www.reddit.com/r/${subreddit}/comments/${post_id}/`,
  };
}

function normalizePost(child: JsonObject | undefined): JsonObject | undefined {
  if (!child || child.kind !== "t3") return undefined;
  const data = object(child.data);
  if (!data) return undefined;
  const id = string(data.id);
  if (!id) return undefined;
  const permalink = redditUrl(data.permalink);
  const outbound = string(data.url_overridden_by_dest ?? data.url);
  return {
    id,
    fullname: string(data.name) ?? `t3_${id}`,
    subreddit: string(data.subreddit),
    title: string(data.title) ?? "",
    body: string(data.selftext) ?? "",
    author: string(data.author),
    score: number(data.score),
    num_comments: number(data.num_comments),
    created_at: isoFromUtc(data.created_utc),
    permalink,
    outbound_url: outbound && outbound !== permalink ? outbound : undefined,
    flair: string(data.link_flair_text),
    is_self: Boolean(data.is_self),
    nsfw: Boolean(data.over_18),
    locked: Boolean(data.locked),
    archived: Boolean(data.archived),
    stickied: Boolean(data.stickied),
  };
}

function normalizeComment(child: JsonObject, depth: number, stats: CommentStats, maxNodes: number): JsonObject | undefined {
  if (child.kind === "more") {
    const data = object(child.data);
    const omitted = array(data?.children).length || number(data?.count) || 0;
    stats.omitted_more += omitted;
    return undefined;
  }
  if (child.kind !== "t1") return undefined;
  if (stats.returned >= maxNodes) {
    stats.truncated = true;
    return undefined;
  }
  const data = object(child.data);
  if (!data) return undefined;
  const id = string(data.id);
  if (!id) return undefined;
  stats.returned += 1;
  const repliesListing = object(data.replies);
  const replies = repliesListing
    ? listingChildren(repliesListing).map(reply => normalizeComment(reply, depth + 1, stats, maxNodes)).filter((item): item is JsonObject => Boolean(item))
    : [];
  return {
    id,
    fullname: string(data.name) ?? `t1_${id}`,
    parent_id: string(data.parent_id),
    subreddit: string(data.subreddit),
    author: string(data.author),
    body: string(data.body) ?? "",
    score: number(data.score),
    created_at: isoFromUtc(data.created_utc),
    permalink: redditUrl(data.permalink),
    depth,
    is_submitter: Boolean(data.is_submitter),
    distinguished: string(data.distinguished),
    stickied: Boolean(data.stickied),
    replies,
  };
}

function findComment(comments: JsonObject[], id: string): JsonObject | undefined {
  for (const comment of comments) {
    if (comment.id === id) return comment;
    const nested = array(comment.replies).map(object).filter((item): item is JsonObject => Boolean(item));
    const found = findComment(nested, id);
    if (found) return found;
  }
  return undefined;
}

function commentShortcut(comment: JsonObject | undefined): JsonObject | undefined {
  if (!comment) return undefined;
  return {
    id: comment.id,
    fullname: comment.fullname,
    author: comment.author,
    body: comment.body,
    score: comment.score,
    created_at: comment.created_at,
    permalink: comment.permalink,
    depth: comment.depth,
  };
}

function topLevelShortcuts(comments: JsonObject[]): { top_comment?: JsonObject; newest_comment?: JsonObject; oldest_comment?: JsonObject } {
  if (!comments.length) return {};
  const byScore = [...comments].sort((a, b) => (number(b.score) ?? Number.NEGATIVE_INFINITY) - (number(a.score) ?? Number.NEGATIVE_INFINITY));
  const byTime = [...comments].sort((a, b) => Date.parse(string(a.created_at) ?? "") - Date.parse(string(b.created_at) ?? ""));
  return {
    top_comment: commentShortcut(byScore[0]),
    oldest_comment: commentShortcut(byTime[0]),
    newest_comment: commentShortcut(byTime[byTime.length - 1]),
  };
}

export function normalizeThreadPayload(payload: unknown, target: RedditThreadTarget, maxNodes = 200): JsonObject {
  const root = array(payload);
  const post = normalizePost(listingChildren(root[0])[0]);
  if (!post) throw new Error("SITE_CHANGED: Reddit thread JSON did not contain the expected post");
  const stats: CommentStats = { returned: 0, omitted_more: 0, truncated: false };
  const comments = listingChildren(root[1]).map(child => normalizeComment(child, 0, stats, maxNodes)).filter((item): item is JsonObject => Boolean(item));
  return {
    target: target.canonical_url,
    target_comment_id: target.comment_id,
    post,
    comments,
    target_comment: target.comment_id ? findComment(comments, target.comment_id) : undefined,
    ...topLevelShortcuts(comments),
    returned_comments: stats.returned,
    omitted_more_comments: stats.omitted_more,
    truncated: stats.truncated,
  };
}

function normalizeActivityItem(child: JsonObject): JsonObject | undefined {
  const data = object(child.data);
  if (!data) return undefined;
  const id = string(data.id);
  if (!id) return undefined;
  if (child.kind === "t3") {
    const permalink = redditUrl(data.permalink);
    const outbound = string(data.url_overridden_by_dest ?? data.url);
    return {
      type: "post",
      id,
      fullname: string(data.name) ?? `t3_${id}`,
      subreddit: string(data.subreddit),
      title: string(data.title) ?? "",
      body: string(data.selftext) ?? "",
      author: string(data.author),
      score: number(data.score),
      num_comments: number(data.num_comments),
      created_at: isoFromUtc(data.created_utc),
      permalink,
      outbound_url: outbound && outbound !== permalink ? outbound : undefined,
    };
  }
  if (child.kind === "t1") {
    return {
      type: "comment",
      id,
      fullname: string(data.name) ?? `t1_${id}`,
      subreddit: string(data.subreddit),
      body: string(data.body) ?? "",
      author: string(data.author),
      score: number(data.score),
      created_at: isoFromUtc(data.created_utc),
      permalink: redditUrl(data.permalink),
      parent_id: string(data.parent_id),
      post_id: string(data.link_id),
      post_title: string(data.link_title),
    };
  }
  return undefined;
}

export function normalizeActivityPayload(payload: unknown): JsonObject[] {
  return listingChildren(payload).map(normalizeActivityItem).filter((item): item is JsonObject => Boolean(item));
}

function normalizeInboxItem(child: JsonObject): JsonObject | undefined {
  const data = object(child.data);
  if (!data) return undefined;
  const id = string(data.id);
  if (!id) return undefined;
  return {
    id,
    fullname: string(data.name) ?? (child.kind === "t4" ? `t4_${id}` : undefined),
    kind: Boolean(data.was_comment) ? "reply" : "message",
    subject: string(data.subject),
    author: string(data.author),
    body: string(data.body) ?? "",
    created_at: isoFromUtc(data.created_utc),
    unread: Boolean(data.new),
    was_comment: Boolean(data.was_comment),
    parent_id: string(data.parent_id),
    subreddit: string(data.subreddit),
    context: redditUrl(data.context),
    distinguished: string(data.distinguished),
  };
}

export function normalizeInboxPayload(payload: unknown): JsonObject[] {
  return listingChildren(payload).map(normalizeInboxItem).filter((item): item is JsonObject => item !== undefined);
}

export class RedditReader {
  constructor(private chrome: ExternalChrome) {}

  async thread(account: string, inputUrl: string, limit = 50, depth = 6, context = 8): Promise<JsonObject> {
    const target = canonicalRedditThreadTarget(inputUrl);
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const safeDepth = Math.max(1, Math.min(10, Math.floor(depth)));
    const safeContext = Math.max(0, Math.min(10, Math.floor(context)));
    const endpoint = target.comment_id
      ? `/r/${encodeURIComponent(target.subreddit)}/comments/${target.post_id}/_/${target.comment_id}.json?raw_json=1&limit=${safeLimit}&depth=${safeDepth}&context=${safeContext}`
      : `/r/${encodeURIComponent(target.subreddit)}/comments/${target.post_id}.json?raw_json=1&limit=${safeLimit}&depth=${safeDepth}`;
    return this.withPage(account, async page => ({
      ...normalizeThreadPayload(await this.fetchJson(page, endpoint), target),
      fetched_at: new Date().toISOString(),
    }));
  }

  async activity(account: string, limit = 25, kind: ActivityKind = "all"): Promise<JsonObject> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withPage(account, async page => {
      const username = await this.username(page);
      const section = kind === "posts" ? "submitted" : kind === "comments" ? "comments" : "overview";
      const payload = await this.fetchJson(page, `/user/${encodeURIComponent(username)}/${section}.json?raw_json=1&limit=${safeLimit}`);
      const items = normalizeActivityPayload(payload);
      return { username, kind, items, count: items.length, fetched_at: new Date().toISOString() };
    });
  }

  async inbox(account: string, unreadOnly = true, limit = 25): Promise<JsonObject> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withPage(account, async page => {
      const username = await this.username(page);
      const endpoint = unreadOnly ? "/message/unread.json" : "/message/inbox.json";
      const payload = await this.fetchJson(page, `${endpoint}?raw_json=1&limit=${safeLimit}`);
      const items = normalizeInboxPayload(payload);
      return { username, unread_only: unreadOnly, items, count: items.length, fetched_at: new Date().toISOString() };
    });
  }

  private async withPage<T>(account: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.chrome.page(account);
    try {
      if (!this.isRedditPage(page.url())) {
        await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      if (!this.isRedditPage(page.url())) throw new Error("TAKEOVER_REQUIRED: Reddit did not open in the authenticated browser session");
      return await fn(page);
    } finally {
      this.chrome.release(account);
    }
  }

  private async username(page: Page): Promise<string> {
    try {
      const payload = await this.fetchJson(page, "/api/me.json?raw_json=1");
      const name = string(object(payload)?.name);
      if (name) return name;
    } catch {
      // Reddit's legacy identity endpoint is not reliable on every current
      // web session. Fall back to the authenticated user menu below.
    }
    const detected = await detectRedditUsername(page);
    if (detected) return detected;
    throw new Error("AUTH_REQUIRED: Reddit account identity is unavailable; complete manual login and retry");
  }

  private async fetchJson(page: Page, endpoint: string): Promise<unknown> {
    const response = await page.evaluate(async path => {
      const result = await fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
      return { status: result.status, url: result.url, text: (await result.text()).slice(0, 2_000_000) };
    }, endpoint);
    if (response.status === 401 || response.status === 403) throw new Error("AUTH_REQUIRED: Reddit rejected the saved browser session; complete manual login and retry");
    if (response.status === 429) throw new Error("RATE_LIMITED: Reddit temporarily rate-limited this read request");
    if (response.status < 200 || response.status >= 300) throw new Error(`REDDIT_READ_FAILED: Reddit returned HTTP ${response.status} for ${endpoint}`);
    try {
      return JSON.parse(response.text);
    } catch {
      throw new Error(`SITE_CHANGED: Reddit returned non-JSON content for ${endpoint}`);
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
}

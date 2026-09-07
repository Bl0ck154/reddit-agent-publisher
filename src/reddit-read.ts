import type { Page } from "playwright-core";
import { ExternalChrome } from "./external-chrome.js";
import { detectRedditUsername } from "./reddit-identity.js";
import { classifyRedditNotification } from "./reddit-preflight.js";

type JsonObject = Record<string, unknown>;
type ActivityKind = "all" | "posts" | "comments";
const redditBellCache = new WeakMap<Page,{expiresAt:number;value:JsonObject}>();

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
    author_fullname: string(data.author_fullname),
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
    author_fullname: comment.author_fullname,
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
    author_fullname: string(data.author_fullname),
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


function decodeRedditHtml(raw: string): string {
  return String(raw ?? "")
    .replace(/&#(x?[0-9a-f]+);/gi,(_,code)=>String.fromCodePoint(code[0].toLowerCase()==="x"?parseInt(code.slice(1),16):parseInt(code,10)))
    .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&amp;/gi,"&");
}

function redditHtmlText(raw: string): string {
  return decodeRedditHtml(String(raw ?? "")
    .replace(/<br\s*\/?\s*>/gi,"\n")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi,"\n")
    .replace(/<[^>]+>/g," "))
    .replace(/[ \t]+/g," ").replace(/\n\s+/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

function htmlAttr(raw: string, name: string): string | undefined {
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const match=String(raw ?? "").match(new RegExp(`\\b${escaped}=(?:"([^"]*)"|'([^']*)')`,"i"));
  return match ? decodeRedditHtml(match[1] ?? match[2] ?? "") : undefined;
}

function redditSubredditFromUrl(value: unknown): string | undefined {
  const raw=string(value); if(!raw) return undefined;
  try { return new URL(raw).pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})(?:\/|$)/i)?.[1]; } catch { return undefined; }
}

function firstRedditHref(raw: string): string | undefined {
  for(const match of String(raw ?? "").matchAll(/\bhref=(?:"([^"]+)"|'([^']+)')/gi)) {
    const url=redditUrl(decodeRedditHtml(match[1] ?? match[2] ?? ""));
    if(url && /\/r\/[A-Za-z0-9_]{2,21}\//i.test(new URL(url).pathname)) return url;
  }
  const text=decodeRedditHtml(raw);
  const direct=text.match(/https:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/[A-Za-z0-9_]{2,21}\/[^\s<"']+/i)?.[0];
  return direct ? redditUrl(direct.replace(/[),.;]+$/,"")) : undefined;
}

export function normalizeRedditBellListHtml(html: string): JsonObject[] {
  const out:JsonObject[]=[];
  for(const match of String(html ?? "").matchAll(/<notification-announcement\b([^>]*)>([\s\S]*?)<\/notification-announcement>/gi)) {
    const attrs=match[1], bodyHtml=match[2];
    const id=htmlAttr(attrs,"announcement-id"); if(!id || !/^ann_[A-Za-z0-9_-]+$/.test(id)) continue;
    const telemetryRaw=htmlAttr(attrs,"notification-telemetry-data");
    let telemetry:JsonObject={}; try { telemetry=telemetryRaw ? JSON.parse(telemetryRaw) as JsonObject : {}; } catch {}
    const titleMatch=bodyHtml.match(/<div\b[^>]*data-testid=(?:"title"|'title')[^>]*>([\s\S]*?)<\/div>/i);
    const bodyMatch=bodyHtml.match(/<div\b[^>]*data-testid=(?:"body"|'body')[^>]*>([\s\S]*?)<\/div>/i);
    const timeAttrs=bodyHtml.match(/<faceplate-timeago\b([^>]*)>/i)?.[1] ?? "";
    const menuAttrs=bodyHtml.match(/<announcement-overflow-menu\b([^>]*)>/i)?.[1] ?? "";
    const title=redditHtmlText(titleMatch?.[1] ?? "") || string(telemetry.title) || "Reddit notification";
    const bodyPreview=redditHtmlText(bodyMatch?.[1] ?? "") || string(telemetry.body) || "";
    const targetUrl=firstRedditHref(bodyHtml) ?? firstRedditHref(bodyPreview);
    const createdAt=htmlAttr(timeAttrs,"ts");
    out.push({
      id, announcement_id:id, kind:"announcement", source:"reddit-bell", subject:title,
      author:htmlAttr(menuAttrs,"author-name"), author_fullname:htmlAttr(menuAttrs,"author-id"),
      body:bodyPreview, body_preview:bodyPreview, created_at:createdAt, target_url:targetUrl, context:targetUrl,
      subreddit:redditSubredditFromUrl(targetUrl), notification_url:`https://www.reddit.com/notifications/a/${id}`,
      read_state:"unknown",
    });
  }
  return out;
}

export function normalizeRedditBellDetailHtml(html: string, expectedId?: string): JsonObject | undefined {
  const detail=String(html ?? "").match(/<announcement-detail\b[^>]*>([\s\S]*?)<\/announcement-detail>/i)?.[1];
  if(!detail) return undefined;
  const menuAttrs=detail.match(/<announcement-overflow-menu\b([^>]*)>/i)?.[1] ?? "";
  const id=htmlAttr(menuAttrs,"announcement-id") ?? expectedId;
  if(!id || !/^ann_[A-Za-z0-9_-]+$/.test(id) || (expectedId && id!==expectedId)) return undefined;
  const title=redditHtmlText(detail.match(/<span\b[^>]*class=(?:"[^"]*text-16[^\"]*font-bold[^\"]*"|'[^']*text-16[^']*font-bold[^']*')[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") || htmlAttr(menuAttrs,"subject") || "Reddit notification";
  const messageHtml=detail.match(/<span\b[^>]*class=(?:"[^"]*message-body[^"]*"|'[^']*message-body[^']*')[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
  const body=redditHtmlText(messageHtml);
  const timeAttrs=detail.match(/<faceplate-timeago\b([^>]*)>/i)?.[1] ?? "";
  const targetUrl=firstRedditHref(messageHtml);
  return {
    id, announcement_id:id, kind:"announcement", source:"reddit-bell", subject:title,
    author:htmlAttr(menuAttrs,"author-name"), author_fullname:htmlAttr(menuAttrs,"author-id"), body,
    created_at:htmlAttr(timeAttrs,"ts"), target_url:targetUrl, context:targetUrl,
    subreddit:redditSubredditFromUrl(targetUrl), notification_url:`https://www.reddit.com/notifications/a/${id}`,
    read_state:"unknown",
  };
}

export function mergeRedditNotificationItems(bellItems: JsonObject[], inboxItems: JsonObject[], limit=25): JsonObject[] {
  const out:JsonObject[]=[]; const seen=new Set<string>();
  for(const item of [...bellItems,...inboxItems]) {
    const target=String(item.target_url ?? item.context ?? "").replace(/[?#].*$/,"").replace(/\/$/,"").toLowerCase();
    const moderation=String(item.notification_type ?? "") === "moderation" || Boolean(item.important);
    const key=moderation && target ? `target:${target}` : `${String(item.source ?? "inbox")}:${String(item.id ?? item.fullname ?? target)}`;
    if(seen.has(key)) continue; seen.add(key); out.push(item);
    if(out.length>=Math.max(1,limit)) break;
  }
  return out;
}

export async function fetchRedditBellNotifications(page: Page, limit=20): Promise<JsonObject> {
  const safeLimit=Math.max(1,Math.min(20,Math.floor(limit)));
  const cached=redditBellCache.get(page);
  if(cached && cached.expiresAt>Date.now()) {
    const items=Array.isArray((cached.value as any).items)?(cached.value as any).items.slice(0,safeLimit):[];
    return {...cached.value,items,count:items.length,cached:true};
  }
  const listResponse=await page.evaluate(async()=>{
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),8_000);
    try {
      const response=await fetch("/svc/shreddit/notifications-inbox-content/20/route",{method:"GET",credentials:"include",headers:{Accept:"text/html"},signal:controller.signal});
      return {status:response.status,url:response.url,text:(await response.text()).slice(0,700_000)};
    } catch(error:any) { return {status:0,url:"/svc/shreddit/notifications-inbox-content/20/route",text:String(error?.message ?? error).slice(0,500)}; }
    finally { clearTimeout(timer); }
  });
  if(listResponse.status<200 || listResponse.status>=300) return {available:false,status:listResponse.status||0,items:[],count:0,note:"Current Reddit bell GET endpoint was unavailable; inbox fallback remains usable."};
  const list=normalizeRedditBellListHtml(listResponse.text).slice(0,safeLimit);
  const detailIds=list.filter((item:any)=>/^AutoModerator$/i.test(String(item.author ?? "")) || /(?:moderator|removed|filtered|karma|requirement|ban)/i.test(`${String(item.subject ?? "")} ${String(item.body ?? "")}`)).slice(0,10).map((item:any)=>String(item.id));
  const details:Record<string,JsonObject>={};
  if(detailIds.length) {
    const responses=await page.evaluate(async(ids:string[])=>{
      return await Promise.all(ids.map(async id=>{
        const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),8_000);
        try {
          const response=await fetch(`/notifications/a/${encodeURIComponent(id)}`,{method:"GET",credentials:"include",headers:{Accept:"text/html"},signal:controller.signal});
          return {id,status:response.status,text:(await response.text()).slice(0,700_000)};
        } catch(error:any) { return {id,status:0,text:String(error?.message ?? error).slice(0,500)}; }
        finally { clearTimeout(timer); }
      }));
    },detailIds);
    for(const response of responses) {
      if(response.status<200 || response.status>=300) continue;
      const parsed=normalizeRedditBellDetailHtml(response.text,response.id); if(parsed) details[response.id]=parsed;
    }
  }
  const items=list.map((item:any)=>classifyRedditNotification(details[String(item.id)] ? {...item,...details[String(item.id)],body_preview:item.body_preview} : item));
  const value:JsonObject={available:true,status:listResponse.status,items,count:items.length,detail_count:Object.keys(details).length,read_state:"unknown",cached:false,fetched_at:new Date().toISOString()};
  redditBellCache.set(page,{expiresAt:Date.now()+30_000,value});
  return value;
}

export class RedditReader {
  constructor(private chrome: ExternalChrome) {}

  async thread(account: string, inputUrl: string, limit = 50, depth = 6, context = 8, sort: "best"|"top"|"new"|"old"|"controversial"|"qa" = "best"): Promise<JsonObject> {
    const target = canonicalRedditThreadTarget(inputUrl);
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const safeDepth = Math.max(1, Math.min(10, Math.floor(depth)));
    const safeContext = Math.max(0, Math.min(10, Math.floor(context)));
    const safeSort = ["best","top","new","old","controversial","qa"].includes(sort) ? sort : "best";
    const endpoint = target.comment_id
      ? `/r/${encodeURIComponent(target.subreddit)}/comments/${target.post_id}/_/${target.comment_id}.json?raw_json=1&limit=${safeLimit}&depth=${safeDepth}&context=${safeContext}&sort=${safeSort}`
      : `/r/${encodeURIComponent(target.subreddit)}/comments/${target.post_id}.json?raw_json=1&limit=${safeLimit}&depth=${safeDepth}&sort=${safeSort}`;
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

  async notifications(account: string, unreadOnly = true, limit = 25): Promise<JsonObject> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withPage(account, async page => {
      const username = await this.username(page);
      const endpoint = unreadOnly ? "/message/unread.json" : "/message/inbox.json";
      let inboxItems:JsonObject[]=[]; let inboxAvailable=true;
      try { inboxItems=normalizeInboxPayload(await this.fetchJson(page, `${endpoint}?raw_json=1&limit=${safeLimit}`)).map(item=>classifyRedditNotification(item)); }
      catch { inboxAvailable=false; }
      const bell=await fetchRedditBellNotifications(page,Math.min(safeLimit,20)).catch(()=>({available:false,items:[],count:0,status:0} as JsonObject));
      const bellItems=Array.isArray((bell as any).items)?(bell as any).items as JsonObject[]:[];
      const items=mergeRedditNotificationItems(bellItems,inboxItems,safeLimit);
      return { username, unread_only: unreadOnly, items, count: items.length, fetched_at: new Date().toISOString(),
        source:(bell as any).available?"reddit-shreddit-bell+safe-inbox":"reddit-safe-inbox", bell_available:Boolean((bell as any).available), bell_read_state:"unknown", inbox_available:inboxAvailable,
        note:(bell as any).available
          ? "Current Reddit bell announcements are read through Reddit's authenticated GET-only Shreddit endpoint; important AutoModerator/moderation cards are enriched through GET-only announcement detail pages. No bell UI is opened and this reader sends no mark-as-read mutation. Bell read/unread state is not inferred when Reddit does not expose it deterministically. Legacy inbox replies/messages are merged as a fallback."
          : "Current Reddit bell GET endpoint was unavailable, so notifications fell back to the safe Reddit inbox. No bell UI was opened and no mark-as-read mutation was sent." };
    });
  }

  private async withPage<T>(account: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await this.chrome.page(account);
    try {
      if (!this.isRedditPage(page.url())) {
        await this.gotoRetry(page, "https://www.reddit.com/");
      }
      if (!this.isRedditPage(page.url())) throw new Error("TAKEOVER_REQUIRED: Reddit did not open in the authenticated browser session");
      return await fn(page);
    } finally {
      this.chrome.release(account);
    }
  }

  private async gotoRetry(page: Page, url: string): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return;
      } catch (error: any) {
        last = error;
        const message = String(error?.message ?? error);
        if (/Timeout 30000ms exceeded/i.test(message)) {
          let reached = false;
          try {
            const actual = new URL(page.url());
            const expected = new URL(url);
            reached = this.isRedditPage(actual.toString()) && actual.pathname === expected.pathname;
          } catch {}
          const body = reached ? (await page.locator("body").innerText().catch(() => "")).trim() : "";
          if (reached && body.length > 40) return;
        }
        if (!message.includes("ERR_CERT_VERIFIER_CHANGED") && !/Timeout 30000ms exceeded/i.test(message)) throw error;
        if (attempt < 2) await page.waitForTimeout(750);
      }
    }
    throw last;
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

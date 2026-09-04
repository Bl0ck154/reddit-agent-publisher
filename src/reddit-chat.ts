import crypto from "node:crypto";
import type { Page } from "playwright-core";
import type { Config } from "./config.js";
import { ExternalChrome } from "./external-chrome.js";

type JsonObject = Record<string, any>;
type TokenCache = { token: string; expiresAt?: number; userId?: string };

const MATRIX_HOME = "https://matrix.redditspace.com";
const CHAT_ROOM = /^![^\s:]{1,220}:reddit\.com$/i;
const MATRIX_USER = /^@t2_([a-z0-9]+):reddit\.com$/i;
const REDDIT_USER = /^[A-Za-z0-9_-]{1,20}$/;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function number(value: unknown): number | undefined { const n = Number(value); return Number.isFinite(n) ? n : undefined; }
function iso(ms: unknown): string | undefined { const n = number(ms); return n === undefined ? undefined : new Date(n).toISOString(); }

export function isRedditChatRoomId(value: string): boolean { return CHAT_ROOM.test(value); }
export function redditMatrixUserIdFromFullname(value: string): string {
  const match = String(value ?? "").trim().match(/^t2_([a-z0-9]+)$/i);
  if (!match) throw new Error("A Reddit t2_ user fullname is required");
  return `@t2_${match[1].toLowerCase()}:reddit.com`;
}
export function normalizeRedditRecipientProfile(value: unknown, expectedUsername?: string): JsonObject {
  const root = object(value);
  const data = object(root?.data);
  const username = text(data?.name);
  const id = text(data?.id);
  if (!username || !id || !/^[a-z0-9]+$/i.test(id)) throw new Error("RECIPIENT_NOT_FOUND: Reddit did not return a valid user profile");
  if (expectedUsername && username.toLowerCase() !== expectedUsername.toLowerCase()) throw new Error("RECIPIENT_IDENTITY_MISMATCH: Reddit username resolved to an unexpected account");
  const fullname = `t2_${id.toLowerCase()}`;
  return { username, fullname, matrix_user_id:redditMatrixUserIdFromFullname(fullname), is_suspended:Boolean(data?.is_suspended) };
}
export function redditDirectRoomCreateBody(ownUserId: string, peerUserId: string): JsonObject {
  if (!MATRIX_USER.test(ownUserId) || !MATRIX_USER.test(peerUserId) || ownUserId === peerUserId) throw new Error("Two distinct Reddit Matrix user ids are required");
  return {
    visibility:"private",
    preset:"trusted_private_chat",
    is_direct:true,
    invite:[peerUserId],
    initial_state:[{ type:"com.reddit.chat.type", state_key:"", content:{ type:"direct", participants:[ownUserId,peerUserId] } }],
  };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

export function extractRedditChatToken(html: string): { token: string; expiresAt?: number } {
  const match = html.match(/<rs-app[^>]*\stoken="([^"]*)"/i);
  if (!match) throw new Error("SITE_CHANGED: Reddit chat bootstrap did not expose an rs-app token");
  let parsed: JsonObject;
  try { parsed = JSON.parse(decodeHtmlAttribute(match[1])); }
  catch { throw new Error("SITE_CHANGED: Reddit chat bootstrap token was malformed"); }
  const token = text(parsed.token);
  if (!token) throw new Error("SITE_CHANGED: Reddit chat bootstrap token is missing");
  const expires = number(parsed.expires);
  return { token, expiresAt: expires };
}

function jwtExpiryMs(token: string): number | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const exp = number(payload.exp);
    return exp === undefined ? undefined : exp * 1000;
  } catch { return undefined; }
}

function directPeers(sync: JsonObject): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const events = array(object(sync.account_data)?.events).map(object).filter(Boolean) as JsonObject[];
  const direct = events.find(event => event.type === "m.direct");
  for (const [userId, rooms] of Object.entries(object(direct?.content) ?? {})) {
    for (const roomId of array(rooms).map(text).filter(Boolean) as string[]) {
      const current = result.get(roomId) ?? [];
      if (!current.includes(userId)) current.push(userId);
      result.set(roomId, current);
    }
  }
  return result;
}

function memberIds(events: JsonObject[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (event.type !== "m.room.member") continue;
    const userId = text(event.state_key);
    const membership = text(object(event.content)?.membership);
    if (userId && (!membership || ["join","invite"].includes(membership)) && !ids.includes(userId)) ids.push(userId);
  }
  return ids;
}

function memberNames(events: JsonObject[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "m.room.member") continue;
    const userId = text(event.state_key);
    const content = object(event.content);
    const display = text(content?.displayname);
    if (userId && display) names.set(userId, display.replace(/^u\//i, ""));
  }
  return names;
}

function normalizeMessage(event: JsonObject, names: Map<string,string>, ownUserId: string): JsonObject | undefined {
  if (event.type !== "m.room.message") return undefined;
  const content = object(event.content);
  if (content?.msgtype !== "m.text") return undefined;
  const body = text(content.body);
  const sender = text(event.sender);
  const eventId = text(event.event_id);
  if (!body || !sender || !eventId) return undefined;
  return {
    event_id: eventId,
    sender_id: sender,
    sender: names.get(sender) ?? sender,
    from_me: sender === ownUserId,
    body,
    created_at: iso(event.origin_server_ts),
  };
}

export function normalizeRedditChatSync(syncValue: unknown, ownUserId: string, unreadOnly = false, limit = 25): JsonObject {
  const sync = object(syncValue) ?? {};
  const peersByRoom = directPeers(sync);
  const joined = object(object(sync.rooms)?.join) ?? {};
  const conversations: JsonObject[] = [];

  for (const [roomId, raw] of Object.entries(joined)) {
    if (!isRedditChatRoomId(roomId)) continue;
    const room = object(raw) ?? {};
    const stateEvents = array(object(room.state)?.events).map(object).filter(Boolean) as JsonObject[];
    const timelineEvents = array(object(room.timeline)?.events).map(object).filter(Boolean) as JsonObject[];
    const names = memberNames([...stateEvents, ...timelineEvents]);
    const messages = timelineEvents.map(event => normalizeMessage(event, names, ownUserId)).filter(Boolean) as JsonObject[];
    const latest = [...messages].sort((a,b)=>Date.parse(String(b.created_at ?? 0))-Date.parse(String(a.created_at ?? 0)))[0];
    const unread = number(object(room.unread_notifications)?.notification_count) ?? 0;
    if (unreadOnly && unread < 1) continue;
    const members = memberIds([...stateEvents, ...timelineEvents]);
    const peerIds = peersByRoom.get(roomId) ?? members.filter(id => id !== ownUserId);
    conversations.push({
      room_id: roomId,
      participants: peerIds.filter(id=>id!==ownUserId).map(id=>({ matrix_user_id:id, username:names.get(id) })),
      unread_count: unread,
      latest_message: latest,
      updated_at: latest?.created_at,
      status: "joined",
    });
  }

  const invited = object(object(sync.rooms)?.invite) ?? {};
  for (const [roomId, raw] of Object.entries(invited)) {
    if (!isRedditChatRoomId(roomId)) continue;
    const room = object(raw) ?? {};
    const inviteEvents = array(object(room.invite_state)?.events).map(object).filter(Boolean) as JsonObject[];
    const names = memberNames(inviteEvents);
    const peers = memberIds(inviteEvents).filter(id=>id!==ownUserId);
    conversations.push({ room_id:roomId, participants:peers.map(id=>({matrix_user_id:id,username:names.get(id)})), unread_count:1, status:"request" });
  }

  conversations.sort((a,b)=>Date.parse(String(b.updated_at ?? 0))-Date.parse(String(a.updated_at ?? 0)));
  return { matrix_user_id: ownUserId, conversations: conversations.slice(0, Math.max(1, Math.min(100, limit))), count:Math.min(conversations.length, Math.max(1, Math.min(100, limit))) };
}


export function findDirectRoomForPeer(syncValue: unknown, ownUserId: string, peerUserId: string): string | undefined {
  if (!MATRIX_USER.test(peerUserId)) throw new Error("A Reddit Matrix user id is required");
  const sync = object(syncValue) ?? {};
  const direct = directPeers(sync);
  const joined = object(object(sync.rooms)?.join) ?? {};
  for (const [roomId, raw] of Object.entries(joined)) {
    if (!isRedditChatRoomId(roomId)) continue;
    if ((direct.get(roomId) ?? []).includes(peerUserId)) return roomId;
    const room = object(raw) ?? {};
    const events = [
      ...array(object(room.state)?.events).map(object).filter(Boolean) as JsonObject[],
      ...array(object(room.timeline)?.events).map(object).filter(Boolean) as JsonObject[],
    ];
    const peers = memberIds(events).filter(id=>id!==ownUserId);
    if (peers.length === 1 && peers[0] === peerUserId) return roomId;
  }
  return undefined;
}

export function normalizeRedditChatMessages(value: unknown, ownUserId: string): JsonObject[] {
  const payload = object(value) ?? {};
  const state = array(payload.state).map(object).filter(Boolean) as JsonObject[];
  const chunk = array(payload.chunk).map(object).filter(Boolean) as JsonObject[];
  const names = memberNames([...state, ...chunk]);
  return chunk.map(event=>normalizeMessage(event,names,ownUserId)).filter(Boolean).reverse() as JsonObject[];
}

export class RedditChat {
  private chrome: ExternalChrome;
  private tokens = new Map<string, TokenCache>();

  constructor(private config: Config) { this.chrome = new ExternalChrome(config, "reddit"); }

  async conversations(account: string, unreadOnly = false, limit = 25): Promise<JsonObject> {
    return this.withMatrix(account, async session => {
      const filter = JSON.stringify({ room:{ timeline:{ limit:20 }, state:{ lazy_load_members:true } } });
      const sync = await this.request(session.token, "/_matrix/client/v3/sync", "GET", undefined, { timeout:"0", filter });
      return { ...normalizeRedditChatSync(sync, session.userId, unreadOnly, limit), fetched_at:new Date().toISOString(), backend:"reddit-matrix" };
    });
  }

  async room(account: string, roomId: string, limit = 50): Promise<JsonObject> {
    this.roomId(roomId);
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withMatrix(account, async session => {
      const payload = await this.request(session.token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`, "GET", undefined, { dir:"b", limit:String(safeLimit) });
      const messages = normalizeRedditChatMessages(payload, session.userId);
      return { room_id:roomId, matrix_user_id:session.userId, messages, count:messages.length, fetched_at:new Date().toISOString(), backend:"reddit-matrix" };
    });
  }

  async directTarget(account: string, username: string, expectedFullname?: string): Promise<JsonObject> {
    const profile = await this.resolveRecipientProfile(account, username, expectedFullname);
    return this.withMatrix(account, async session => {
      if (profile.matrix_user_id === session.userId) throw new Error("RECIPIENT_SELF: cannot start a Reddit Chat with the connected account itself");
      const sync = await this.sync(session.token);
      const existing = findDirectRoomForPeer(sync, session.userId, String(profile.matrix_user_id));
      return { ...profile, existing_room_id:existing, will_create_message_request:!existing, backend:"reddit-matrix" };
    });
  }

  async sendDirectMessage(account: string, username: string, body: string, expectedFullname?: string, transactionKey?: string): Promise<JsonObject> {
    const message = body.trim();
    if (!message || message.length > 40_000) throw new Error("Reddit direct-message body must contain 1-40000 characters");
    const profile = await this.resolveRecipientProfile(account, username, expectedFullname);
    return this.withMatrix(account, async session => {
      const peer = String(profile.matrix_user_id);
      if (peer === session.userId) throw new Error("RECIPIENT_SELF: cannot start a Reddit Chat with the connected account itself");
      const sync = await this.sync(session.token);
      let roomId = findDirectRoomForPeer(sync, session.userId, peer);
      let created = false;
      const warnings: string[] = [];
      if (!roomId) {
        let createdPayload: unknown;
        try {
          createdPayload = await this.request(session.token, "/_matrix/client/v3/createRoom", "POST", redditDirectRoomCreateBody(session.userId, peer));
        } catch (error:any) {
          const failure = String(error?.message ?? error);
          if (/HTTP 403|M_FORBIDDEN|forbidden/i.test(failure)) throw new Error("RECIPIENT_CHAT_UNAVAILABLE: Reddit does not allow starting a chat with this user");
          if (/^REDDIT_CHAT_FAILED:|^RATE_LIMITED:|^AUTH_REQUIRED:|Matrix authentication/i.test(failure)) throw error;
          try {
            const recoveredSync = await this.sync(session.token);
            roomId = findDirectRoomForPeer(recoveredSync, session.userId, peer);
          } catch { /* preserve the ambiguous create result below */ }
          if (!roomId) throw new Error("PUBLISH_RESULT_AMBIGUOUS: Reddit Chat room creation may have succeeded but its result could not be verified; automatic retry is stopped to avoid creating a duplicate message request");
          warnings.push("Recovered an already-created Reddit Chat room after an interrupted create response; no duplicate room was created.");
        }
        if (createdPayload !== undefined) {
          roomId = text(object(createdPayload)?.room_id);
          if (!roomId || !isRedditChatRoomId(roomId)) throw new Error("PUBLISH_RESULT_AMBIGUOUS: Reddit Chat room creation did not return a valid room id");
          created = true;
          try {
            const directEvent = array(object(object(sync)?.account_data)?.events).map(object).filter(Boolean).find((event:any)=>event.type==="m.direct") as JsonObject | undefined;
            const content = { ...(object(directEvent?.content) ?? {}) };
            const rooms = array(content[peer]).map(text).filter(Boolean) as string[];
            if (!rooms.includes(roomId)) rooms.push(roomId);
            content[peer] = rooms;
            await this.request(session.token, `/_matrix/client/v3/user/${encodeURIComponent(session.userId)}/account_data/m.direct`, "PUT", content);
          } catch {
            warnings.push("Reddit Chat was created, but the Matrix m.direct account-data marker could not be updated; the room itself is still valid.");
          }
        }
      }
      if (!roomId) throw new Error("PUBLISH_RESULT_AMBIGUOUS: Reddit Chat target room could not be resolved");
      const eventId = await this.sendInRoom(session.token, roomId, message, transactionKey);
      return { status:"PUBLISHED", room_id:roomId, event_id:eventId, recipient:profile, created_conversation:created, warnings, backend:"reddit-matrix" };
    });
  }

  async sendMessage(account: string, roomId: string, body: string, transactionKey?: string): Promise<JsonObject> {
    this.roomId(roomId);
    const message = body.trim();
    if (!message || message.length > 40_000) throw new Error("Reddit chat reply body must contain 1-40000 characters");
    return this.withMatrix(account, async session => {
      const eventId = await this.sendInRoom(session.token, roomId, message, transactionKey);
      return { status:"PUBLISHED", room_id:roomId, event_id:eventId, backend:"reddit-matrix" };
    });
  }

  private async resolveRecipientProfile(account: string, username: string, expectedFullname?: string): Promise<JsonObject> {
    const requested = String(username ?? "").trim().replace(/^u\//i, "");
    if (!REDDIT_USER.test(requested)) throw new Error("RECIPIENT_NOT_FOUND: a valid Reddit username is required");
    const page = await this.chrome.page(account);
    try {
      if (!/^https:\/\/(?:www\.|old\.|new\.)?reddit\.com(?:\/|$)/i.test(page.url())) await page.goto("https://www.reddit.com/", {waitUntil:"domcontentloaded",timeout:30_000});
      const response = await page.evaluate(async name => {
        const result = await fetch(`/user/${encodeURIComponent(name)}/about.json?raw_json=1`, {credentials:"include",headers:{Accept:"application/json"}});
        return {status:result.status,text:(await result.text()).slice(0,200_000)};
      }, requested);
      if (response.status === 401 || response.status === 403) throw new Error("AUTH_REQUIRED: Reddit rejected the saved browser session while resolving the DM recipient");
      if (response.status === 404) throw new Error("RECIPIENT_NOT_FOUND: Reddit user does not exist");
      if (response.status < 200 || response.status >= 300) throw new Error(`REDDIT_CHAT_FAILED: Reddit user lookup returned HTTP ${response.status}`);
      let payload: unknown;
      try { payload=JSON.parse(response.text); } catch { throw new Error("SITE_CHANGED: Reddit user lookup returned non-JSON content"); }
      const profile = normalizeRedditRecipientProfile(payload, requested);
      if (expectedFullname && String(profile.fullname).toLowerCase() !== String(expectedFullname).toLowerCase()) throw new Error("RECIPIENT_IDENTITY_MISMATCH: the verified Reddit account id does not match the source comment");
      if (profile.is_suspended) throw new Error("RECIPIENT_CHAT_UNAVAILABLE: Reddit account is suspended");
      return profile;
    } finally { this.chrome.release(account); }
  }

  private async sync(token: string): Promise<unknown> {
    const filter = JSON.stringify({ room:{ timeline:{limit:20}, state:{lazy_load_members:true} } });
    return this.request(token, "/_matrix/client/v3/sync", "GET", undefined, {timeout:"0",filter});
  }

  private async sendInRoom(token: string, roomId: string, body: string, transactionKey?: string): Promise<string> {
    this.roomId(roomId);
    const safeKey = String(transactionKey ?? crypto.randomUUID()).replace(/[^A-Za-z0-9._~-]/g,"_").slice(0,120);
    const txn = `publisher-${safeKey}`;
    const payload = await this.request(token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`, "PUT", {msgtype:"m.text",body});
    const eventId = text(object(payload)?.event_id);
    if (!eventId) throw new Error("PUBLISH_RESULT_AMBIGUOUS: Reddit Chat did not return a Matrix event id");
    return eventId;
  }

  private roomId(roomId: string): string {
    if (!isRedditChatRoomId(roomId)) throw new Error("A Reddit Chat room_id returned by reddit_chat_list is required");
    return roomId;
  }

  private async withMatrix<T>(account: string, work: (session:{token:string;userId:string})=>Promise<T>): Promise<T> {
    const page = await this.chrome.page(account);
    try {
      const session = await this.session(account, page);
      try { return await work(session); }
      catch (error:any) {
        if (!/M_UNKNOWN_TOKEN|HTTP 401|Matrix authentication/i.test(String(error?.message ?? error))) throw error;
        this.tokens.delete(account);
        const fresh = await this.session(account, page, true);
        return await work(fresh);
      }
    } finally { this.chrome.release(account); }
  }

  private async session(account: string, page: Page, force = false): Promise<{token:string;userId:string}> {
    const cached = this.tokens.get(account);
    if (!force && cached?.token && (!cached.expiresAt || cached.expiresAt > Date.now()+60_000)) {
      if (cached.userId) return { token:cached.token, userId:cached.userId };
      const me = object(await this.request(cached.token, "/_matrix/client/v3/account/whoami", "GET"));
      const userId = text(me?.user_id); if (userId) { cached.userId=userId; return {token:cached.token,userId}; }
    }

    if (!/^https:\/\/(?:www\.|old\.|new\.)?reddit\.com(?:\/|$)/i.test(page.url())) {
      await page.goto("https://www.reddit.com/", { waitUntil:"domcontentloaded", timeout:30_000 });
    }
    const cookies = await page.context().cookies("https://www.reddit.com/");
    const redditSession = cookies.find(cookie=>cookie.name==="reddit_session")?.value;
    if (!redditSession) throw new Error("AUTH_REQUIRED: Reddit browser session is not logged in");

    if (!force) {
      const tokenV2 = cookies.find(cookie=>cookie.name==="token_v2")?.value;
      if (tokenV2) {
        try {
          const me = object(await this.request(tokenV2, "/_matrix/client/v3/account/whoami", "GET"));
          const userId = text(me?.user_id);
          if (userId) {
            const value={token:tokenV2,userId,expiresAt:jwtExpiryMs(tokenV2)}; this.tokens.set(account,value); return {token:tokenV2,userId};
          }
        } catch { /* stale token_v2: mint a fresh Matrix token below */ }
      }
    }

    const userAgent = await page.evaluate(()=>navigator.userAgent).catch(()=>"Mozilla/5.0");
    const cookieHeader = cookies.filter(cookie=>cookie.name!=="token_v2").map(cookie=>`${cookie.name}=${cookie.value}`).join("; ");
    const bootstrap = await fetch("https://www.reddit.com/chat/", { headers:{ Cookie:cookieHeader, "User-Agent":userAgent, Accept:"text/html,application/xhtml+xml" }, redirect:"follow" });
    if (bootstrap.status === 401 || bootstrap.status === 403) throw new Error("AUTH_REQUIRED: Reddit rejected the saved browser session for Chat");
    if (!bootstrap.ok) throw new Error(`REDDIT_CHAT_FAILED: Reddit chat bootstrap returned HTTP ${bootstrap.status}`);
    const minted = extractRedditChatToken(await bootstrap.text());
    const login = await fetch(`${MATRIX_HOME}/_matrix/client/v3/login`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({type:"com.reddit.token",token:minted.token,initial_device_display_name:"agent-publisher"}) });
    if (!login.ok) throw new Error(`AUTH_REQUIRED: Reddit Matrix login rejected the browser-minted token with HTTP ${login.status}`);
    const loginBody = object(await login.json().catch(()=>({}))) ?? {};
    const userId = text(loginBody.user_id) ?? text(object(await this.request(minted.token, "/_matrix/client/v3/account/whoami", "GET"))?.user_id);
    if (!userId) throw new Error("SITE_CHANGED: Reddit Matrix login did not return a user id");
    this.tokens.set(account,{token:minted.token,expiresAt:minted.expiresAt ?? jwtExpiryMs(minted.token),userId});
    return {token:minted.token,userId};
  }

  private async request(token: string, path: string, method: "GET"|"PUT"|"POST", body?:unknown, query?:Record<string,string>): Promise<unknown> {
    const url = new URL(path, MATRIX_HOME);
    for (const [key,value] of Object.entries(query ?? {})) url.searchParams.set(key,value);
    const response = await fetch(url, { method, headers:{ Authorization:`Bearer ${token}`, ...(body===undefined?{}:{"content-type":"application/json"}) }, body:body===undefined?undefined:JSON.stringify(body) });
    const payload = await response.json().catch(()=>({}));
    if (response.status === 401) throw new Error(`Matrix authentication failed: ${String(object(payload)?.errcode ?? "HTTP 401")}`);
    if (response.status === 429) throw new Error("RATE_LIMITED: Reddit Chat temporarily rate-limited the request");
    if (!response.ok) throw new Error(`REDDIT_CHAT_FAILED: Matrix returned HTTP ${response.status} ${String(object(payload)?.errcode ?? "")}: ${String(object(payload)?.error ?? "unknown error")}`);
    return payload;
  }
}

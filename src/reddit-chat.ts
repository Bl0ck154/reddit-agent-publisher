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
export function redditMatrixUserIdFromSelfProfile(value: unknown): string {
  const root=object(value); const data=object(root?.data);
  const id=text(data?.id); const name=text(data?.name);
  if (root?.kind !== "t2" || !id || !name || !/^[a-z0-9]+$/i.test(id)) throw new Error("AUTH_REQUIRED: Reddit browser account identity is unavailable");
  return redditMatrixUserIdFromFullname(`t2_${id}`);
}
export function normalizeRedditRecipientProfile(value: unknown, expectedUsername?: string): JsonObject {
  const root = object(value);
  const data = object(root?.data);
  const username = text(data?.name);
  const id = text(data?.id);
  if (!username || !id || !/^[a-z0-9]+$/i.test(id)) throw new Error("RECIPIENT_NOT_FOUND: Reddit did not return a valid user profile");
  if (expectedUsername && username.toLowerCase() !== expectedUsername.toLowerCase()) throw new Error("RECIPIENT_IDENTITY_MISMATCH: Reddit username resolved to an unexpected account");
  const fullname = `t2_${id.toLowerCase()}`;
  const acceptChats = typeof data?.accept_chats === "boolean" ? data.accept_chats : undefined;
  const isBlocked = typeof data?.is_blocked === "boolean" ? data.is_blocked : undefined;
  return { username, fullname, matrix_user_id:redditMatrixUserIdFromFullname(fullname), is_suspended:Boolean(data?.is_suspended), accept_chats:acceptChats, is_blocked:isBlocked };
}
export function redditDirectRoomCreateBody(ownUserId: string, peerUserId: string): JsonObject {
  if (!MATRIX_USER.test(ownUserId) || !MATRIX_USER.test(peerUserId) || ownUserId === peerUserId) throw new Error("Two distinct Reddit Matrix user ids are required");
  // Match Reddit Chat's current web client exactly. The server-side `reddit_dm`
  // preset owns the direct-room state (including Reddit-specific room metadata).
  return { preset:"reddit_dm", invite:[peerUserId] };
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

function parseStoredString(value: unknown): string | undefined {
  const raw=text(value); if(!raw) return undefined;
  try { const parsed=JSON.parse(raw); return typeof parsed === "string" && parsed.trim() ? parsed : raw; } catch { return raw; }
}

export function extractRedditChatLocalStorageCredentials(value: unknown): {token:string;userId:string;deviceId?:string} | undefined {
  const kv=object(value) ?? {};
  const userId=parseStoredString(kv["chat:matrix-user-id"]);
  let token=parseStoredString(kv["chat:matrix-access-token"]);
  if(!token){
    const legacy=text(kv["chat:access-token"]);
    if(legacy){ try { token=text(object(JSON.parse(legacy))?.token); } catch { /* malformed legacy entry */ } }
  }
  const deviceId=parseStoredString(kv["chat:matrix-device-id"]);
  if(!userId || !MATRIX_USER.test(userId) || !token) return undefined;
  return {token,userId,...(deviceId?{deviceId}:{})};
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

function invitePeerId(events: JsonObject[], ownUserId: string): string | undefined {
  const selfInvite=events.find(event=>event.type==="m.room.member" && text(event.state_key)===ownUserId && text(object(event.content)?.membership)==="invite");
  const sender=text(selfInvite?.sender);
  if (sender && sender!==ownUserId && MATRIX_USER.test(sender)) return sender;
  const statePeer=memberIds(events).find(id=>id!==ownUserId && MATRIX_USER.test(id));
  if (statePeer) return statePeer;
  const fallback=text(events.find(event=>event.type==="m.room.member")?.sender);
  return fallback && fallback!==ownUserId && MATRIX_USER.test(fallback) ? fallback : undefined;
}

function memberNames(events: JsonObject[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "m.room.member") continue;
    const userId = text(event.state_key);
    const content = object(event.content);
    const relations = object(object(event.unsigned)?.["m.relations"]);
    const redditProfile = object(relations?.["com.reddit.profile"]);
    const redditUsername = text(redditProfile?.username);
    const display = text(content?.displayname);
    const username = redditUsername ?? display;
    if (userId && username) names.set(userId, username.replace(/^u\//i, ""));
  }
  return names;
}

function normalizeMessage(event: JsonObject, names: Map<string,string>, ownUserId: string, allowInvitePreview = false): JsonObject | undefined {
  const content = object(event.content);
  const ordinaryText = event.type === "m.room.message" && content?.msgtype === "m.text";
  const invitePreview = allowInvitePreview && typeof content?.body === "string" && content.body.trim();
  if (!ordinaryText && !invitePreview) return undefined;
  const body = text(content?.body);
  const sender = text(event.sender);
  const eventId = text(event.event_id) ?? (invitePreview ? `invite-preview:${event.type}:${String(event.state_key ?? sender ?? "unknown")}` : undefined);
  if (!body || !sender || !eventId) return undefined;
  return {
    event_id: eventId,
    sender_id: sender,
    sender: names.get(sender) ?? sender,
    from_me: sender === ownUserId,
    body,
    created_at: iso(event.origin_server_ts),
    ...(ordinaryText ? {} : { preview_only:true, event_type:event.type }),
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
    const inviter=invitePeerId(inviteEvents,ownUserId);
    const peers = inviter ? [inviter] : memberIds(inviteEvents).filter(id=>id!==ownUserId);
    const messages = inviteEvents.map(event=>normalizeMessage(event,names,ownUserId,true)).filter(Boolean) as JsonObject[];
    const latest = [...messages].sort((a,b)=>Date.parse(String(b.created_at ?? 0))-Date.parse(String(a.created_at ?? 0)))[0];
    conversations.push({ room_id:roomId, participants:peers.map(id=>({matrix_user_id:id,username:names.get(id)})), unread_count:1, latest_message:latest, updated_at:latest?.created_at, status:"request" });
  }

  conversations.sort((a,b)=>Date.parse(String(b.updated_at ?? 0))-Date.parse(String(a.updated_at ?? 0)));
  return { matrix_user_id: ownUserId, conversations: conversations.slice(0, Math.max(1, Math.min(100, limit))), count:Math.min(conversations.length, Math.max(1, Math.min(100, limit))) };
}


export type RedditDirectRoomMatch = { room_id:string; status:"joined"|"request" };

export function findDirectChatForPeer(syncValue: unknown, ownUserId: string, peerUserId: string): RedditDirectRoomMatch | undefined {
  if (!MATRIX_USER.test(peerUserId)) throw new Error("A Reddit Matrix user id is required");
  const sync = object(syncValue) ?? {};
  const direct = directPeers(sync);
  const joined = object(object(sync.rooms)?.join) ?? {};
  for (const [roomId, raw] of Object.entries(joined)) {
    if (!isRedditChatRoomId(roomId)) continue;
    if ((direct.get(roomId) ?? []).includes(peerUserId)) return {room_id:roomId,status:"joined"};
    const room = object(raw) ?? {};
    const events = [
      ...array(object(room.state)?.events).map(object).filter(Boolean) as JsonObject[],
      ...array(object(room.timeline)?.events).map(object).filter(Boolean) as JsonObject[],
    ];
    const peers = memberIds(events).filter(id=>id!==ownUserId);
    if (peers.length === 1 && peers[0] === peerUserId) return {room_id:roomId,status:"joined"};
  }
  const invited = object(object(sync.rooms)?.invite) ?? {};
  for (const [roomId, raw] of Object.entries(invited)) {
    if (!isRedditChatRoomId(roomId)) continue;
    const room = object(raw) ?? {};
    const events = array(object(room.invite_state)?.events).map(object).filter(Boolean) as JsonObject[];
    const inviter=invitePeerId(events,ownUserId);
    if (inviter === peerUserId) return {room_id:roomId,status:"request"};
    const peers = memberIds(events).filter(id=>id!==ownUserId);
    if (peers.length === 1 && peers[0] === peerUserId) return {room_id:roomId,status:"request"};
  }
  return undefined;
}

export function findDirectRoomForPeer(syncValue: unknown, ownUserId: string, peerUserId: string): string | undefined {
  return findDirectChatForPeer(syncValue, ownUserId, peerUserId)?.room_id;
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
  private profileNames = new Map<string, string>();

  constructor(private config: Config) { this.chrome = new ExternalChrome(config, "reddit"); }

  async conversations(account: string, unreadOnly = false, limit = 25): Promise<JsonObject> {
    return this.withMatrix(account, async session => {
      const filter = JSON.stringify({ room:{ timeline:{ limit:20 }, state:{ lazy_load_members:true } } });
      const sync = await this.request(session.token, "/_matrix/client/v3/sync", "GET", undefined, { timeout:"0", filter });
      const normalized = normalizeRedditChatSync(sync, session.userId, unreadOnly, limit);
      await this.enrichConversationNames(session.token, normalized);
      return { ...normalized, fetched_at:new Date().toISOString(), backend:"reddit-matrix" };
    });
  }

  async room(account: string, roomId: string, limit = 50): Promise<JsonObject> {
    this.roomId(roomId);
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withMatrix(account, async session => {
      const sync = object(await this.sync(session.token)) ?? {};
      const invited = object(object(sync.rooms)?.invite) ?? {};
      if (invited[roomId]) {
        const events = array(object(object(invited[roomId])?.invite_state)?.events).map(object).filter(Boolean) as JsonObject[];
        const names = memberNames(events);
        const messages = events.map(event=>normalizeMessage(event,names,session.userId,true)).filter(Boolean).slice(-safeLimit) as JsonObject[];
        await this.enrichMessageSenderNames(session.token, messages);
        return { room_id:roomId, matrix_user_id:session.userId, status:"request", messages, count:messages.length, fetched_at:new Date().toISOString(), backend:"reddit-matrix", note:"This is a pending Reddit message request. Reading it did not accept the request; sending a reply will accept/join it first." };
      }
      const payload = await this.request(session.token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`, "GET", undefined, { dir:"b", limit:String(safeLimit) });
      const messages = normalizeRedditChatMessages(payload, session.userId);
      await this.enrichMessageSenderNames(session.token, messages);
      return { room_id:roomId, matrix_user_id:session.userId, status:"joined", messages, count:messages.length, fetched_at:new Date().toISOString(), backend:"reddit-matrix" };
    });
  }

  async directTarget(account: string, username: string, expectedFullname?: string): Promise<JsonObject> {
    const profile = await this.resolveRecipientProfile(account, username, expectedFullname);
    return this.withMatrix(account, async session => {
      if (profile.matrix_user_id === session.userId) throw new Error("RECIPIENT_SELF: cannot start a Reddit Chat with the connected account itself");
      const sync = await this.sync(session.token);
      let existing = findDirectChatForPeer(sync, session.userId, String(profile.matrix_user_id));
      if (!existing) {
        const serverRoom = await this.directRoomFromServer(session.token, String(profile.matrix_user_id));
        if (serverRoom) existing = {room_id:serverRoom,status:"joined"};
      }
      return { ...profile, existing_room_id:existing?.room_id, existing_room_status:existing?.status, will_accept_message_request:existing?.status==="request", will_create_message_request:!existing, backend:"reddit-matrix" };
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
      let match = findDirectChatForPeer(sync, session.userId, peer);
      if (!match) {
        const serverRoom = await this.directRoomFromServer(session.token, peer);
        if (serverRoom) match = {room_id:serverRoom,status:"joined"};
      }
      let roomId = match?.room_id;
      let roomStatus = match?.status;
      let created = false;
      const warnings: string[] = [];
      if (roomId && roomStatus === "request") {
        await this.joinRoom(session.token, roomId);
        roomStatus = "joined";
        warnings.push("Accepted the existing Reddit message request before sending the reply; no duplicate chat was created.");
      }
      if (!roomId) {
        let createdPayload: unknown;
        try {
          createdPayload = await this.request(session.token, "/_matrix/client/v3/createRoom", "POST", redditDirectRoomCreateBody(session.userId, peer));
        } catch (error:any) {
          const failure = String(error?.message ?? error);
          const matrixPayload = object(error?.matrixPayload);
          const existingFromError = text(matrixPayload?.["com.reddit.existing_room_id"]);
          const redditErrorCode = text(matrixPayload?.["com.reddit.error.code"]);
          if (existingFromError && isRedditChatRoomId(existingFromError)) {
            roomId = existingFromError;
            roomStatus = "joined";
            warnings.push("Reddit reported an existing direct room during room creation; reused it instead of creating a duplicate.");
          } else {
            if (/^rate\.score_(?:room_creation|invitation)_limit(?:_ln)?$/i.test(redditErrorCode ?? "")) throw new Error(`RATE_LIMITED: Reddit Chat room creation is temporarily limited (${redditErrorCode})`);
            if (redditErrorCode === "feature_gated") throw new Error("RECIPIENT_CHAT_UNAVAILABLE: Reddit has feature-gated starting this chat for the connected account");
            if (/HTTP 403|M_FORBIDDEN|forbidden/i.test(failure)) throw new Error("RECIPIENT_CHAT_UNAVAILABLE: Reddit does not allow starting a chat with this user");
            if (/^RATE_LIMITED:|^AUTH_REQUIRED:|Matrix authentication/i.test(failure)) throw error;
            const status = Number(error?.matrixStatus ?? failure.match(/Matrix returned HTTP (\d+)/i)?.[1] ?? 0);
            // A conflict can mean the direct room already appeared concurrently, so let
            // the recovery lookup below prove that before failing. Other deterministic
            // client errors indicate Reddit's contract changed; blind retries are unsafe.
            if (status >= 400 && status < 500 && status !== 408 && status !== 409) {
              throw new Error(`SITE_CHANGED: Reddit Chat room creation returned unrecognized HTTP ${status}${redditErrorCode ? ` (${redditErrorCode})` : ""}`);
            }
            try {
              const serverRoom = await this.directRoomFromServer(session.token, peer);
              if (serverRoom) { roomId=serverRoom; roomStatus="joined"; }
              if (!roomId) {
                const recoveredSync = await this.sync(session.token);
                match = findDirectChatForPeer(recoveredSync, session.userId, peer);
                roomId = match?.room_id;
                roomStatus = match?.status;
              }
              if (roomId && roomStatus === "request") { await this.joinRoom(session.token, roomId); roomStatus="joined"; }
            } catch { /* preserve the ambiguous create result below */ }
            if (!roomId) throw new Error("PUBLISH_RESULT_AMBIGUOUS: Reddit Chat room creation may have succeeded but its result could not be verified; automatic retry is stopped to avoid creating a duplicate message request");
            warnings.push("Recovered an already-created Reddit Chat room after an interrupted create response; no duplicate room was created.");
          }
        }
        if (createdPayload !== undefined) {
          roomId = text(object(createdPayload)?.room_id);
          if (!roomId || !isRedditChatRoomId(roomId)) throw new Error("PUBLISH_RESULT_AMBIGUOUS: Reddit Chat room creation did not return a valid room id");
          created = true;
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
      const sync = object(await this.sync(session.token)) ?? {};
      const invited = object(object(sync.rooms)?.invite) ?? {};
      let acceptedMessageRequest = false;
      if (invited[roomId]) { await this.joinRoom(session.token, roomId); acceptedMessageRequest = true; }
      const eventId = await this.sendInRoom(session.token, roomId, message, transactionKey);
      return { status:"PUBLISHED", room_id:roomId, event_id:eventId, accepted_message_request:acceptedMessageRequest, backend:"reddit-matrix" };
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
      if (profile.is_blocked === true) throw new Error("RECIPIENT_CHAT_UNAVAILABLE: this Reddit account is blocked by the connected account");
      // `accept_chats` is advisory only: Reddit has historically returned false for
      // profiles whose authenticated web UI still exposes Start Chat. The definitive
      // permission check is Matrix createRoom/join at publish time (403 => unavailable).
      return profile;
    } finally { this.chrome.release(account); }
  }


  private async matrixProfileName(token: string, userId: string): Promise<string | undefined> {
    if (!MATRIX_USER.test(userId)) return undefined;
    const cached=this.profileNames.get(userId); if(cached) return cached;
    try {
      const profile=object(await this.request(token, `/_matrix/client/v3/profile/${encodeURIComponent(userId)}`, "GET"));
      const name=text(profile?.displayname)?.replace(/^u\//i, "");
      if(name) this.profileNames.set(userId,name);
      return name;
    } catch(error:any) {
      const failure=String(error?.message ?? error);
      if (/M_UNKNOWN_TOKEN|HTTP 401|Matrix authentication/i.test(failure)) throw error;
      return undefined;
    }
  }

  private async enrichConversationNames(token: string, payload: JsonObject): Promise<void> {
    const participants=array(payload.conversations).flatMap(raw=>array(object(raw)?.participants).map(object).filter(Boolean)) as JsonObject[];
    const missing=[...new Set(participants.filter(p=>!text(p.username)).map(p=>text(p.matrix_user_id)).filter((id): id is string=>Boolean(id && MATRIX_USER.test(id))))];
    const resolved=new Map<string,string>();
    await Promise.all(missing.map(async id=>{const name=await this.matrixProfileName(token,id); if(name) resolved.set(id,name);}));
    for(const participant of participants){const id=text(participant.matrix_user_id); if(id && !text(participant.username) && resolved.has(id)) participant.username=resolved.get(id);}
  }

  private async enrichMessageSenderNames(token: string, messages: JsonObject[]): Promise<void> {
    const missing=[...new Set(messages.filter(m=>text(m.sender)===text(m.sender_id)).map(m=>text(m.sender_id)).filter((id): id is string=>Boolean(id && MATRIX_USER.test(id))))];
    const resolved=new Map<string,string>();
    await Promise.all(missing.map(async id=>{const name=await this.matrixProfileName(token,id); if(name) resolved.set(id,name);}));
    for(const message of messages){const id=text(message.sender_id); if(id && text(message.sender)===id && resolved.has(id)) message.sender=resolved.get(id);}
  }

  private async directRoomFromServer(token: string, peerUserId: string): Promise<string | undefined> {
    if (!MATRIX_USER.test(peerUserId)) throw new Error("A Reddit Matrix user id is required");
    const payload = object(await this.request(token, "/_matrix/client/v3/rooms", "GET", undefined, {
      seq:"y", with_user:peerUserId, type:"direct", include:"state,timeline",
    })) ?? {};
    for (const raw of array(payload.rooms)) {
      const roomId = text(object(raw)?.room_id);
      if (roomId && isRedditChatRoomId(roomId)) return roomId;
    }
    return undefined;
  }

  private async joinRoom(token: string, roomId: string): Promise<void> {
    this.roomId(roomId);
    try {
      await this.request(token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, "POST", {});
    } catch (error:any) {
      const failure=String(error?.message ?? error);
      if (/HTTP 403|M_FORBIDDEN|forbidden/i.test(failure)) throw new Error("RECIPIENT_CHAT_UNAVAILABLE: the Reddit message request can no longer be accepted");
      throw error;
    }
  }

  private async sync(token: string): Promise<unknown> {
    const filter = JSON.stringify({ room:{ timeline:{limit:20}, state:{lazy_load_members:true} } });
    return this.request(token, "/_matrix/client/v3/sync", "GET", undefined, {timeout:"0",filter});
  }

  private async sendInRoom(token: string, roomId: string, body: string, transactionKey?: string): Promise<string> {
    this.roomId(roomId);
    const safeKey = String(transactionKey ?? crypto.randomUUID()).replace(/[^A-Za-z0-9._~-]/g,"_").slice(0,120);
    const txn = `publisher-${safeKey}`;
    let payload: unknown;
    try {
      payload = await this.request(token, `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`, "PUT", {msgtype:"m.text",body});
    } catch (error:any) {
      const failure=String(error?.message ?? error);
      const matrixPayload=object(error?.matrixPayload);
      const status=Number(error?.matrixStatus ?? failure.match(/Matrix returned HTTP (\d+)/i)?.[1] ?? 0);
      const matrixText=`${text(matrixPayload?.errcode) ?? ""} ${text(matrixPayload?.error) ?? ""} ${failure}`;
      if (/User is flagged for spam/i.test(matrixText)) throw new Error("SENDER_CHAT_RESTRICTED: Reddit rejected this connected account/device as spam or insufficiently trusted for Chat sending");
      if (/^RATE_LIMITED:|^AUTH_REQUIRED:|Matrix authentication/i.test(failure)) throw error;
      if (status === 403 || /M_FORBIDDEN/i.test(matrixText)) throw new Error("RECIPIENT_CHAT_UNAVAILABLE: Reddit no longer allows sending a message in this chat");
      if (status === 404) throw new Error("RECIPIENT_CHAT_UNAVAILABLE: the Reddit Chat room no longer exists or is no longer accessible");
      if (status >= 400 && status < 500 && status !== 408 && status !== 409) throw new Error(`SITE_CHANGED: Reddit Chat send returned unrecognized HTTP ${status}`);
      throw error;
    }
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
    if (!/^https:\/\/(?:www\.|old\.|new\.)?reddit\.com(?:\/|$)/i.test(page.url())) {
      await page.goto("https://www.reddit.com/", { waitUntil:"domcontentloaded", timeout:30_000 });
    }
    const expectedUserId = await this.browserMatrixUserId(page);
    const cached = this.tokens.get(account);
    if (!force && cached?.token && (!cached.expiresAt || cached.expiresAt > Date.now()+60_000)) {
      if (cached.userId === expectedUserId) return { token:cached.token, userId:cached.userId };
      if (!cached.userId) {
        try {
          const me = object(await this.request(cached.token, "/_matrix/client/v3/account/whoami", "GET"));
          const userId = text(me?.user_id);
          if (userId === expectedUserId) { cached.userId=userId; return {token:cached.token,userId}; }
        } catch { /* refresh below */ }
      }
      this.tokens.delete(account);
    }

    const cookies = await page.context().cookies("https://www.reddit.com/");
    const redditSession = cookies.find(cookie=>cookie.name==="reddit_session")?.value;
    if (!redditSession) throw new Error("AUTH_REQUIRED: Reddit browser session is not logged in");

    // Prefer the established credentials Reddit Chat already stored in this browser.
    // This avoids minting unnecessary new Matrix devices, which Reddit may trust less.
    const stored = await this.browserStoredMatrixCredentials(page);
    if (stored?.userId === expectedUserId) {
      try {
        const me=object(await this.request(stored.token,"/_matrix/client/v3/account/whoami","GET"));
        const userId=text(me?.user_id);
        if(userId===expectedUserId){const value={token:stored.token,userId,expiresAt:jwtExpiryMs(stored.token)}; this.tokens.set(account,value); return {token:stored.token,userId};}
      } catch { /* stale browser Chat token: try token_v2/fresh mint below */ }
    }

    const tokenV2 = cookies.find(cookie=>cookie.name==="token_v2")?.value;
    if (tokenV2) {
      try {
        const me = object(await this.request(tokenV2, "/_matrix/client/v3/account/whoami", "GET"));
        const userId = text(me?.user_id);
        if (userId === expectedUserId) {
          const value={token:tokenV2,userId,expiresAt:jwtExpiryMs(tokenV2)}; this.tokens.set(account,value); return {token:tokenV2,userId};
        }
      } catch { /* stale token_v2: mint a fresh Matrix token below */ }
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
    if (userId !== expectedUserId) throw new Error("AUTH_REQUIRED: Reddit Matrix identity does not match the current authenticated browser account");
    this.tokens.set(account,{token:minted.token,expiresAt:minted.expiresAt ?? jwtExpiryMs(minted.token),userId});
    return {token:minted.token,userId};
  }

  private async browserStoredMatrixCredentials(page: Page): Promise<{token:string;userId:string;deviceId?:string} | undefined> {
    try {
      const values=await page.evaluate(()=>{
        const keys=["chat:matrix-user-id","chat:matrix-device-id","chat:matrix-access-token","chat:access-token"];
        return Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key) ?? ""]));
      });
      return extractRedditChatLocalStorageCredentials(values);
    } catch { return undefined; }
  }

  private async browserMatrixUserId(page: Page): Promise<string> {
    const response=await page.evaluate(async()=>{
      const result=await fetch("/api/me.json?raw_json=1",{credentials:"include",headers:{Accept:"application/json"}});
      return {status:result.status,text:(await result.text()).slice(0,200_000)};
    });
    if (response.status === 401 || response.status === 403) throw new Error("AUTH_REQUIRED: Reddit rejected the saved browser session while binding Chat identity");
    if (response.status < 200 || response.status >= 300) throw new Error(`REDDIT_CHAT_FAILED: Reddit self lookup returned HTTP ${response.status}`);
    let payload:unknown; try { payload=JSON.parse(response.text); } catch { throw new Error("SITE_CHANGED: Reddit self lookup returned non-JSON content"); }
    return redditMatrixUserIdFromSelfProfile(payload);
  }

  private async request(token: string, path: string, method: "GET"|"PUT"|"POST", body?:unknown, query?:Record<string,string>): Promise<unknown> {
    const url = new URL(path, MATRIX_HOME);
    for (const [key,value] of Object.entries(query ?? {})) url.searchParams.set(key,value);
    const response = await fetch(url, { method, headers:{ Authorization:`Bearer ${token}`, ...(body===undefined?{}:{"content-type":"application/json"}) }, body:body===undefined?undefined:JSON.stringify(body) });
    const payload = await response.json().catch(()=>({}));
    if (!response.ok) {
      let message: string;
      if (response.status === 401) message = `Matrix authentication failed: ${String(object(payload)?.errcode ?? "HTTP 401")}`;
      else if (response.status === 429) message = "RATE_LIMITED: Reddit Chat temporarily rate-limited the request";
      else message = `REDDIT_CHAT_FAILED: Matrix returned HTTP ${response.status} ${String(object(payload)?.errcode ?? "")}: ${String(object(payload)?.error ?? "unknown error")}`;
      const error:any = new Error(message);
      error.matrixStatus = response.status;
      error.matrixPayload = payload;
      throw error;
    }
    return payload;
  }
}

#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import { ensureState, loadConfig } from "./config.js";
import { ExternalChrome } from "./external-chrome.js";
import { RedditReader } from "./reddit-read.js";
import { RedditChat } from "./reddit-chat.js";
import { PublisherService } from "./service.js";
import { envelope, type ResultEnvelope } from "./types.js";

const config = loadConfig(); ensureState(config); const service = new PublisherService(config);
const redditReader = new RedditReader(new ExternalChrome(config, "reddit"));
const redditChat = new RedditChat(config);

async function redditRead(work: () => Promise<unknown>): Promise<ResultEnvelope> {
  try {
    return envelope({ adapter:"reddit", result:await work() });
  } catch (error: any) {
    const message = String(error?.message ?? error);
    const code = message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? "INTERNAL_ERROR";
    return envelope({ ok:false, adapter:"reddit", error:{ code, message } });
  }
}

async function dispatch(method: string, p: any) {
  switch (method) {
    case "prepare": return service.prepare(p.input, p.actor);
    case "preview": return service.preview(p.draft_id, p.actor);
    case "approve": return service.approve(p.draft_id, p.preview_digest, p.confirmation, p.actor);
    case "publish": return service.publish(p.draft_id, p.approval_token, p.actor);
    case "action_publish_confirmed": return service.publishConfirmedAction(p.draft_id, p.preview_digest, p.actor);
    case "login": return service.login(p.adapter, p.account ?? "default", p.extra ?? {});
    case "status": return service.status(p.adapter, p.account ?? "default");
    case "pending": return service.pending();
    case "reddit_rules": return service.rules(p.account ?? "default", p.subreddit);
    case "reddit_flairs": return service.flairs(p.account ?? "default", p.subreddit);
    case "reddit_thread": return redditRead(() => redditReader.thread(p.account ?? "default", p.url, p.limit ?? 50, p.depth ?? 6, p.context ?? 8, p.sort ?? "best"));
    case "reddit_activity": return redditRead(() => redditReader.activity(p.account ?? "default", p.limit ?? 25, p.kind ?? "all"));
    case "reddit_inbox": return redditRead(() => redditReader.inbox(p.account ?? "default", p.unread_only ?? true, p.limit ?? 25));
    case "reddit_notifications": return redditRead(() => redditReader.notifications(p.account ?? "default", p.unread_only ?? true, p.limit ?? 25));
    case "reddit_chat_list": return redditRead(() => redditChat.conversations(p.account ?? "default", p.unread_only ?? false, p.limit ?? 25));
    case "reddit_chat_get": return redditRead(() => redditChat.room(p.account ?? "default", p.room_id, p.limit ?? 50));
    case "reddit_chat_attachment_get": return redditRead(() => redditChat.attachment(p.account ?? "default", p.room_id, p.event_id));
    case "diagnose": return service.diagnose(Boolean(p.live));
    case "artifact": return service.artifact(p.path,p.offset ?? 0,p.max_bytes ?? 8_000_000);
    default: throw new Error(`Unknown RPC method: ${method}`);
  }
}

if (fs.existsSync(config.socketPath)) fs.unlinkSync(config.socketPath);
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/rpc") { res.writeHead(404).end(); return; }
  const chunks: Buffer[] = []; req.on("data", c => chunks.push(c)); req.on("end", async () => {
    try { const { method, params } = JSON.parse(Buffer.concat(chunks).toString("utf8")); const result = await dispatch(method, params ?? {});
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result)); }
    catch (e: any) { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ schema_version:"1.0", ok:false, request_id:crypto.randomUUID(), side_effect:{performed:false}, warnings:[], next_actions:[], error:{code:"INTERNAL_ERROR",message:e.message} })); }
  });
});
server.listen(config.socketPath, () => { fs.chmodSync(config.socketPath, 0o600); console.error(`publisherd listening on ${config.socketPath}`); });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)));

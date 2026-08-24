#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { buildActionsOpenApi } from "./actions-schema.js";
import { loadConfig } from "./config.js";
import { ActionFileError, prepareGptActionImages } from "./gpt-action-files.js";
import { rpc } from "./rpc.js";
import type { ResultEnvelope } from "./types.js";

const config = loadConfig();
const keyFile = process.env.PUBLISHER_ACTIONS_API_KEY_FILE;
if (!keyFile || !fs.existsSync(keyFile)) throw new Error("PUBLISHER_ACTIONS_API_KEY_FILE must point to the systemd credential file");
const apiKey = fs.readFileSync(keyFile, "utf8").trim();
if (apiKey.length < 32) throw new Error("GPT Actions API key is unexpectedly short");

const rate = new Map<string, { started: number; count: number }>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;
const MAX_BODY = 64 * 1024;

const Account = z.string().min(1).max(80).default("default");
const GptFileRef = z.union([z.string(),z.object({name:z.string().optional(),id:z.string().optional(),mime_type:z.string().optional(),download_link:z.string().url()}).passthrough()]);
const RedditPost = z.object({ subreddit:z.string().min(2).max(21),title:z.string().min(1).max(300),body:z.string().max(40_000).optional(),url:z.string().url().optional(),flair:z.string().max(200).optional(),openaiFileIdRefs:z.array(GptFileRef).min(1).max(4).optional(),account:Account.optional() }).strict()
  .refine(value=>!(value.url && value.openaiFileIdRefs?.length),{message:"A Reddit post cannot contain both a link URL and uploaded images."});
const RedditComment = z.object({ url:z.string().url(),body:z.string().min(1).max(40_000),account:Account.optional() }).strict();
const RedditDelete = z.object({ url:z.string().url(),account:Account.optional() }).strict();
const PublishBody = z.object({ preview_digest:z.string().min(16).max(256) }).strict();

type PreviewKind = "reddit-post"|"reddit-comment"|"reddit-edit"|"reddit-delete";

function publicBase(req: IncomingMessage): string {
  if (config.actionsPublicBaseUrl) return config.actionsPublicBaseUrl.replace(/\/$/, "");
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const protocol = forwarded === "https" ? "https" : "http";
  const host = String(req.headers.host ?? "").trim();
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return "https://replace-me.invalid";
  return `${protocol}://${host}`;
}

function json(res: ServerResponse, status: number, value: unknown, cache = false): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": cache ? "public, max-age=300" : "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function text(res: ServerResponse, status: number, value: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(value), "x-content-type-options":"nosniff" });
  res.end(value);
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(req: IncomingMessage): boolean {
  const auth = String(req.headers.authorization ?? "");
  return auth.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), apiKey);
}

function clientId(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function allowRate(req: IncomingMessage): boolean {
  const id = clientId(req); const now = Date.now(); const current = rate.get(id);
  if (!current || now - current.started >= WINDOW_MS) { rate.set(id, { started:now,count:1 }); return true; }
  current.count += 1; return current.count <= MAX_REQUESTS;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk); total += b.length;
    if (total > MAX_BODY) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(b);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function errorMessage(env: ResultEnvelope): string {
  const code = env.error?.code ?? "UNKNOWN_ERROR";
  if (["AUTH_REQUIRED","TAKEOVER_REQUIRED"].includes(code)) return "The saved browser session needs a manual sign-in or verification on the server before this can continue.";
  if (code === "APPROVAL_STALE") return "That preview expired or changed. Create a fresh preview before publishing.";
  if (code === "ACCOUNT_BUSY") return "The publishing browser is busy with another write. Try this action again shortly.";
  if (code === "RATE_LIMITED") return "The publisher is cooling down after a recent write. Try again shortly.";
  if (code === "SITE_CHANGED") return "The site UI changed and the publisher stopped safely instead of guessing. The browser adapter needs inspection.";
  return env.error?.message ?? "The publisher could not complete this operation.";
}

function actionLabel(_adapter?: string, action?: unknown): string {
  const a = String(action ?? "");
  if (a === "create_post") return "Reddit post";
  if (a === "create_comment") return "Reddit comment";
  if (a === "edit") return "Reddit edit";
  if (a === "delete") return "Reddit deletion";
  return "Reddit publication";
}

function previewOutput(env: ResultEnvelope, kind: PreviewKind): Record<string, unknown> {
  if (!env.ok) return { ok:false, message:errorMessage(env), error_code:env.error?.code, details:env.error?.details };
  const preview = env.preview as any;
  const labels: Record<PreviewKind,string> = {
    "reddit-post":"The Reddit post is ready to publish. Nothing has been posted yet.",
    "reddit-comment":"The Reddit comment is ready to publish. Nothing has been posted yet.",
    "reddit-edit":"The Reddit edit is ready. Nothing has been saved yet.",
    "reddit-delete":"The Reddit deletion target is verified and ready. Nothing has been deleted yet.",
  };
  return { ok:true, message:labels[kind], draft_id:env.draft_id, preview_digest:preview?.digest,
    expires_at:preview?.expires_at, requires_confirmation:true, preview:preview?.summary };
}

function publishOutput(env: ResultEnvelope): Record<string, unknown> {
  if (!env.ok) return { ok:false, message:errorMessage(env), error_code:env.error?.code, details:env.error?.details };
  const result = (env.result ?? {}) as any; const label = actionLabel(env.adapter, result.action);
  const already = Boolean(result.already_published);
  return { ok:true, message:already ? `${label} was already published; no duplicate was created.` : `Done — the ${label.toLowerCase()} was published successfully.`,
    published_url:result.url, already_published:already, warnings:env.warnings ?? [] };
}

async function local(method: string, params: Record<string, unknown> = {}): Promise<ResultEnvelope> {
  return rpc(config.socketPath, method, { ...params, actor:"gpt-action" });
}

async function preparePreview(input: Record<string, unknown>, kind: PreviewKind): Promise<Record<string, unknown>> {
  const prepared = await local("prepare", { input:{ ...input, owner_command:true } });
  if (!prepared.ok || !prepared.draft_id) return { ok:false, message:errorMessage(prepared), error_code:prepared.error?.code, details:prepared.error?.details };
  const preview = await local("preview", { draft_id:prepared.draft_id });
  return previewOutput(preview, kind);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://gateway.local");

  if (req.method === "GET" && url.pathname === "/health") { json(res,200,{ok:true,service:"reddit-agent-publisher-actions"},true); return; }
  if (req.method === "GET" && url.pathname === "/openapi.json") { json(res,200,buildActionsOpenApi(publicBase(req))); return; }
  if (req.method === "GET" && url.pathname === "/privacy") {
    text(res,200,`<!doctype html><html><head><meta charset="utf-8"><title>Reddit Agent Publisher Privacy Policy</title></head><body><main><h1>Reddit Agent Publisher Privacy Policy</h1><p>This privately operated service accepts content only to perform publishing actions requested by its authenticated owner. Draft content is stored encrypted by the publisher, browser sessions remain on the owner-controlled server, and the service does not sell personal data.</p><p>Authentication secrets are not returned through GPT Actions. Reddit account passwords, 2FA codes, and CAPTCHA answers are entered only in the owner's browser session.</p><p>Operational metadata may be retained for security and audit purposes. The owner can remove stored drafts, artifacts, browser profiles, and the service itself from the server.</p></main></body></html>`,"text/html; charset=utf-8"); return;
  }

  if (!url.pathname.startsWith("/v1/")) { json(res,404,{ok:false,message:"Not found."}); return; }
  if (!authorized(req)) { res.setHeader("www-authenticate","Bearer"); json(res,401,{ok:false,message:"Unauthorized."}); return; }
  if (!allowRate(req)) { json(res,429,{ok:false,message:"Too many requests. Try again shortly."}); return; }

  if (req.method === "GET" && url.pathname === "/v1/status") {
    const adapter = url.searchParams.get("adapter") ?? undefined; const account = url.searchParams.get("account") ?? "default";
    if (adapter && adapter !== "reddit") { json(res,400,{ok:false,message:"Invalid adapter."}); return; }
    const env = await local("status", { adapter,account });
    json(res,200,env.ok ? {ok:true,message:"Publisher session status checked.",data:env.result} : {ok:false,message:errorMessage(env),error_code:env.error?.code}); return;
  }
  if (req.method === "GET" && (url.pathname === "/v1/reddit/rules" || url.pathname === "/v1/reddit/flairs")) {
    const subreddit = url.searchParams.get("subreddit") ?? ""; const account = url.searchParams.get("account") ?? "default";
    if (!/^[A-Za-z0-9_]{2,21}$/.test(subreddit)) { json(res,400,{ok:false,message:"Invalid subreddit name."}); return; }
    const env = await local(url.pathname.endsWith("rules") ? "reddit_rules" : "reddit_flairs", {subreddit,account});
    json(res,200,env.ok ? {ok:true,message:url.pathname.endsWith("rules")?"Subreddit rules loaded.":"Available Reddit flairs loaded.",data:env.result} : {ok:false,message:errorMessage(env),error_code:env.error?.code}); return;
  }

  if (req.method === "POST") {
    const raw = await readJson(req);
    if (url.pathname === "/v1/reddit/posts/preview") {
      const b=RedditPost.parse(raw);
      const media_files=b.openaiFileIdRefs?.length ? await prepareGptActionImages(b.openaiFileIdRefs,config.stateDir) : undefined;
      json(res,200,await preparePreview({adapter:"reddit",account:b.account??"default",action:"create_post",target:{subreddit:b.subreddit},content:{title:b.title,body:b.body??"",url:b.url,flair:b.flair,media_files}},"reddit-post")); return;
    }
    if (url.pathname === "/v1/reddit/comments/preview") {
      const b=RedditComment.parse(raw); json(res,200,await preparePreview({adapter:"reddit",account:b.account??"default",action:"create_comment",target:{url:b.url},content:{body:b.body}},"reddit-comment")); return;
    }
    if (url.pathname === "/v1/reddit/edits/preview") {
      const b=RedditComment.parse(raw); json(res,200,await preparePreview({adapter:"reddit",account:b.account??"default",action:"edit",target:{url:b.url},content:{body:b.body}},"reddit-edit")); return;
    }
    if (url.pathname === "/v1/reddit/deletes/preview") {
      const b=RedditDelete.parse(raw); json(res,200,await preparePreview({adapter:"reddit",account:b.account??"default",action:"delete",target:{url:b.url},content:{}},"reddit-delete")); return;
    }
    const publish = url.pathname.match(/^\/v1\/publications\/([0-9a-f-]{36})\/publish$/i);
    if (publish) {
      const b=PublishBody.parse(raw); const env=await local("action_publish_confirmed",{draft_id:publish[1],preview_digest:b.preview_digest}); json(res,200,publishOutput(env)); return;
    }
  }

  json(res,404,{ok:false,message:"Not found."});
}

const server = http.createServer((req,res) => {
  void route(req,res).catch((error:any) => {
    if (error?.message === "REQUEST_TOO_LARGE") { json(res,413,{ok:false,message:"Request body is too large."}); return; }
    if (error instanceof ActionFileError) { json(res,error.status,{ok:false,message:error.message,error_code:error.code}); return; }
    if (error instanceof z.ZodError) { json(res,400,{ok:false,message:"Invalid action input.",details:error.issues.map(i=>({path:i.path.join("."),message:i.message}))}); return; }
    if (error instanceof SyntaxError) { json(res,400,{ok:false,message:"Invalid JSON body."}); return; }
    console.error("actions gateway error", error);
    json(res,500,{ok:false,message:"The Actions gateway hit an internal error."});
  });
});

server.listen(config.actionsPort ?? 8791, config.actionsHost ?? "127.0.0.1", () => {
  console.error(`publisher-actions listening on http://${config.actionsHost ?? "127.0.0.1"}:${config.actionsPort ?? 8791}`);
});
for (const sig of ["SIGINT","SIGTERM"] as const) process.on(sig,()=>server.close(()=>process.exit(0)));

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { rpc } from "./rpc.js";

const socket = loadConfig().socketPath;
const server = new McpServer({ name:"reddit-agent-publisher", version:"0.2.0" });
const run = async (method:string, params:any) => { const r=await rpc(socket,method,{...params,actor:"mcp"}); return { content:[{type:"text" as const,text:JSON.stringify(r)}], structuredContent:r as any, isError:!r.ok }; };
const account = z.string().default("default").describe("Internal Publisher browser-profile id, not the Reddit username. Usually omit it or leave default; use another value only when it is a configured Publisher profile id returned by status.");
const redditUrl = z.string().url();

server.registerTool("publication_prepare", { description:"Prepare exactly one owner-requested draft. This never publishes. Kept for compatibility; prefer the typed Reddit tools.", inputSchema:{ adapter:z.enum(["reddit"]),account,action:z.enum(["create_post","create_comment","edit","delete"]),target:z.record(z.unknown()),content:z.record(z.unknown()),owner_command:z.literal(true) } }, p=>run("prepare",{input:p}));
server.registerTool("publication_preview", { description:"Preview one Reddit draft in the live browser; nothing is submitted.", inputSchema:{draft_id:z.string().uuid()} }, p=>run("preview",p));
server.registerTool("publication_approve", { description:"Approve one fresh preview after the owner explicitly confirms in chat. Requires the exact preview digest and confirm=true; does not publish.", inputSchema:{draft_id:z.string().uuid(),preview_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),confirm:z.literal(true)} }, p=>run("approve",{draft_id:p.draft_id,preview_digest:p.preview_digest,confirmation:`APPROVE ${p.draft_id}`}));
server.registerTool("publication_publish", { description:"Publish one previously previewed and explicitly approved draft.", inputSchema:{draft_id:z.string().uuid(),approval_token:z.string()} }, p=>run("publish",p));
server.registerTool("publication_edit", { description:"Prepare (not execute) one edit draft. Kept for compatibility.", inputSchema:{adapter:z.enum(["reddit"]),account,target:z.record(z.unknown()),content:z.record(z.unknown()),owner_command:z.literal(true)} }, p=>run("prepare",{input:{...p,action:"edit"}}));
server.registerTool("publication_delete", { description:"Prepare (not execute) one delete draft. Kept for compatibility.", inputSchema:{adapter:z.enum(["reddit"]),account,target:z.record(z.unknown()),owner_command:z.literal(true)} }, p=>run("prepare",{input:{...p,action:"delete",content:{}}}));

server.registerTool("reddit_post_prepare", {
  description:"Prepare one Reddit post with a typed schema. This never clicks Post.",
  inputSchema:{subreddit:z.string().regex(/^[A-Za-z0-9_]{2,21}$/),title:z.string().min(1).max(300),body:z.string().max(40_000).optional(),url:redditUrl.optional(),flair:z.string().max(200).optional(),account}
}, p=>run("prepare",{input:{adapter:"reddit",account:p.account,action:"create_post",target:{subreddit:p.subreddit},content:{title:p.title,body:p.body,url:p.url,flair:p.flair},owner_command:true}}));
server.registerTool("reddit_comment_prepare", {
  description:"Prepare a top-level Reddit comment for an exact post permalink. This never submits it.",
  inputSchema:{url:redditUrl,body:z.string().min(1).max(40_000),account}
}, p=>run("prepare",{input:{adapter:"reddit",account:p.account,action:"create_comment",target:{url:p.url},content:{body:p.body},owner_command:true}}));
server.registerTool("reddit_reply_prepare", {
  description:"Prepare a Reddit reply for an exact comment permalink. This never submits it.",
  inputSchema:{url:redditUrl,body:z.string().min(1).max(40_000),account}
}, p=>run("prepare",{input:{adapter:"reddit",account:p.account,action:"create_comment",target:{url:p.url},content:{body:p.body},owner_command:true}}));
server.registerTool("reddit_edit_prepare", {
  description:"Prepare an edit of the owner's exact Reddit post/comment. This never saves it.",
  inputSchema:{url:redditUrl,body:z.string().min(1).max(40_000),account}
}, p=>run("prepare",{input:{adapter:"reddit",account:p.account,action:"edit",target:{url:p.url},content:{body:p.body},owner_command:true}}));
server.registerTool("reddit_delete_prepare", {
  description:"Prepare deletion of the owner's exact Reddit post/comment. This never confirms deletion.",
  inputSchema:{url:redditUrl,account}
}, p=>run("prepare",{input:{adapter:"reddit",account:p.account,action:"delete",target:{url:p.url},content:{},owner_command:true}}));

server.registerTool("auth_login", { description:"Open a persistent browser for manual login, 2FA, or CAPTCHA takeover. Never accepts passwords.", inputSchema:{adapter:z.enum(["reddit"]),account} }, p=>run("login",{adapter:p.adapter,account:p.account}));
server.registerTool("account_status", { description:"Read authentication status.", inputSchema:{adapter:z.enum(["reddit"]).optional(),account} }, p=>run("status",p));
server.registerTool("pending_list", { description:"List drafts that are not complete.", inputSchema:{} }, p=>run("pending",p));
server.registerTool("reddit_rules", { description:"Read subreddit rules through the persistent Reddit browser; no API credentials required.", inputSchema:{subreddit:z.string().regex(/^[A-Za-z0-9_]{2,21}$/),account} }, p=>run("reddit_rules",p));
server.registerTool("reddit_flairs", { description:"Read available post flair from the Reddit create-post UI; no API credentials required and nothing is submitted.", inputSchema:{subreddit:z.string().regex(/^[A-Za-z0-9_]{2,21}$/),account} }, p=>run("reddit_flairs",p));
server.registerTool("reddit_thread_get", {
  description:"Read a Reddit post plus nested comment context from an exact post/comment permalink. Read-only.",
  inputSchema:{url:redditUrl,account,limit:z.number().int().min(1).max(100).default(50),depth:z.number().int().min(1).max(10).default(6),context:z.number().int().min(0).max(10).default(8)}
}, p=>run("reddit_thread",p));
server.registerTool("reddit_my_activity", {
  description:"Read the authenticated owner's recent Reddit posts/comments. Read-only.",
  inputSchema:{account,kind:z.enum(["all","posts","comments"]).default("all"),limit:z.number().int().min(1).max(100).default(25)}
}, p=>run("reddit_activity",p));
server.registerTool("reddit_inbox", {
  description:"Read the authenticated owner's Reddit inbox/replies. Read-only; unread_only defaults to true.",
  inputSchema:{account,unread_only:z.boolean().default(true),limit:z.number().int().min(1).max(100).default(25)}
}, p=>run("reddit_inbox",p));
server.registerTool("diagnostics_run", { description:"Run local, optionally read-only live adapter diagnostics.", inputSchema:{live:z.boolean().default(false)} }, p=>run("diagnose",p));
server.registerTool("artifact_get", {description:"Return a preview screenshot as base64 plus its SHA-256 hash.",inputSchema:{path:z.string()}},p=>run("artifact",p));

await server.connect(new StdioServerTransport());

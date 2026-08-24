#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { rpc } from "./rpc.js";

const socket = loadConfig().socketPath;
const server = new McpServer({ name:"reddit-agent-publisher", version:"0.2.0" });
const run = async (method:string, params:any) => { const r=await rpc(socket,method,{...params,actor:"mcp"}); return { content:[{type:"text" as const,text:JSON.stringify(r)}], structuredContent:r as any, isError:!r.ok }; };

server.registerTool("publication_prepare", { description:"Prepare exactly one owner-requested draft. This never publishes.", inputSchema:{ adapter:z.enum(["reddit"]),account:z.string().default("default"),action:z.enum(["create_post","create_comment","edit","delete"]),target:z.record(z.unknown()),content:z.record(z.unknown()),owner_command:z.literal(true) } }, p=>run("prepare",{input:p}));
server.registerTool("publication_preview", { description:"Preview one Reddit draft in the live browser; nothing is submitted.", inputSchema:{draft_id:z.string().uuid()} }, p=>run("preview",p));
server.registerTool("publication_approve", { description:"Approve one fresh preview after the owner explicitly confirms in chat. Requires the exact preview digest and confirm=true; does not publish.", inputSchema:{draft_id:z.string().uuid(),preview_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),confirm:z.literal(true)} }, p=>run("approve",{draft_id:p.draft_id,preview_digest:p.preview_digest,confirmation:`APPROVE ${p.draft_id}`}));
server.registerTool("publication_publish", { description:"Publish one previously previewed and explicitly approved draft.", inputSchema:{draft_id:z.string().uuid(),approval_token:z.string()} }, p=>run("publish",p));
server.registerTool("publication_edit", { description:"Prepare (not execute) one edit draft.", inputSchema:{adapter:z.enum(["reddit"]),account:z.string().default("default"),target:z.record(z.unknown()),content:z.record(z.unknown()),owner_command:z.literal(true)} }, p=>run("prepare",{input:{...p,action:"edit"}}));
server.registerTool("publication_delete", { description:"Prepare (not execute) one delete draft.", inputSchema:{adapter:z.enum(["reddit"]),account:z.string().default("default"),target:z.record(z.unknown()),owner_command:z.literal(true)} }, p=>run("prepare",{input:{...p,action:"delete",content:{}}}));
server.registerTool("auth_login", { description:"Open a persistent browser for manual login, 2FA, or CAPTCHA takeover. Never accepts passwords.", inputSchema:{adapter:z.enum(["reddit"]),account:z.string().default("default")} }, p=>run("login",{adapter:p.adapter,account:p.account}));
server.registerTool("account_status", { description:"Read authentication status.", inputSchema:{adapter:z.enum(["reddit"]).optional(),account:z.string().default("default")} }, p=>run("status",p));
server.registerTool("pending_list", { description:"List drafts that are not complete.", inputSchema:{} }, p=>run("pending",p));
server.registerTool("reddit_rules", { description:"Read subreddit rules through the persistent Reddit browser; no API credentials required.", inputSchema:{subreddit:z.string(),account:z.string().default("default")} }, p=>run("reddit_rules",p));
server.registerTool("reddit_flairs", { description:"Read available post flair from the Reddit create-post UI; no API credentials required and nothing is submitted.", inputSchema:{subreddit:z.string(),account:z.string().default("default")} }, p=>run("reddit_flairs",p));
server.registerTool("diagnostics_run", { description:"Run local, optionally read-only live adapter diagnostics.", inputSchema:{live:z.boolean().default(false)} }, p=>run("diagnose",p));
server.registerTool("artifact_get", {description:"Return a preview screenshot as base64 plus its SHA-256 hash.",inputSchema:{path:z.string()}},p=>run("artifact",p));

await server.connect(new StdioServerTransport());

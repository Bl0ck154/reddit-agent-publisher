#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureState, loadConfig } from "./config.js";
import { PublisherService } from "./service.js";

const config = loadConfig();
ensureState(config);
const publisher = new PublisherService(config);
const server = new McpServer({ name: "reddit-agent-publisher", version: "0.1.0" });

function result(value: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as any,
    isError: !value.ok
  };
}

server.registerTool("publication_prepare", {
  description: "Prepare one owner-requested Reddit draft. This does not submit it.",
  inputSchema: {
    account: z.string().default("default"),
    action: z.enum(["create_post", "create_comment", "edit", "delete"]),
    target: z.record(z.unknown()),
    content: z.record(z.unknown()).default({}),
    owner_command: z.literal(true)
  }
}, async (input) => result(await publisher.prepare({ adapter: "reddit", ...input }, "mcp")));

server.registerTool("publication_preview", {
  description: "Prepare the live Reddit form and return a preview without submitting it.",
  inputSchema: { draft_id: z.string().uuid() }
}, async ({ draft_id }) => result(await publisher.preview(draft_id, "mcp")));

server.registerTool("publication_approve", {
  description: "Approve one exact fresh preview after explicit owner confirmation.",
  inputSchema: {
    draft_id: z.string().uuid(),
    preview_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    confirm: z.literal(true)
  }
}, async ({ draft_id, preview_digest }) => result(await publisher.approve(draft_id, preview_digest, `APPROVE ${draft_id}`, "mcp")));

server.registerTool("publication_publish", {
  description: "Submit one previously previewed and approved Reddit draft.",
  inputSchema: { draft_id: z.string().uuid(), approval_token: z.string().min(16) }
}, async ({ draft_id, approval_token }) => result(await publisher.publish(draft_id, approval_token, "mcp")));

server.registerTool("auth_login", {
  description: "Open the persistent Reddit browser session for manual authentication when needed.",
  inputSchema: { account: z.string().default("default") }
}, async ({ account }) => result(await publisher.login(account)));

server.registerTool("account_status", {
  description: "Read Reddit session status.",
  inputSchema: { account: z.string().default("default") }
}, async ({ account }) => result(await publisher.status(account)));

server.registerTool("reddit_rules", {
  description: "Read the current rules page for one subreddit.",
  inputSchema: { subreddit: z.string(), account: z.string().default("default") }
}, async ({ subreddit, account }) => result(await publisher.rules(account, subreddit)));

server.registerTool("reddit_flairs", {
  description: "Read visible post flair choices from the Reddit post form.",
  inputSchema: { subreddit: z.string(), account: z.string().default("default") }
}, async ({ subreddit, account }) => result(await publisher.flairs(account, subreddit)));

server.registerTool("pending_list", {
  description: "List incomplete local drafts.",
  inputSchema: {}
}, async () => result(await publisher.pending()));

server.registerTool("diagnostics_run", {
  description: "Run local diagnostics.",
  inputSchema: { live: z.boolean().default(false) }
}, async ({ live }) => result(await publisher.diagnose(live)));

await server.connect(new StdioServerTransport());

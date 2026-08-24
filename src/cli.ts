#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { rpc } from "./rpc.js";

const program = new Command().name("pubctl").description("Owner-approved Reddit publishing CLI").version("0.2.0");
const config = loadConfig();
const out = (x: unknown) => { process.stdout.write(`${JSON.stringify(x, null, 2)}\n`); if ((x as any)?.ok === false) process.exitCode = 1; };
const call = async (method: string, params: any = {}) => out(await rpc(config.socketPath, method, { ...params, actor: "cli" }));
const text = (value?: string, file?: string) => file ? fs.readFileSync(file, "utf8") : (value ?? "");

function localImages(files?: string[]): Array<Record<string, unknown>> | undefined {
  if (!files?.length) return undefined;
  if (files.length > 4) throw new Error("Reddit image posts support at most four images.");
  const root = path.join(config.stateDir, "artifacts", "local-files");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return files.map((requested, index) => {
    const source = fs.realpathSync(requested);
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw new Error(`Image ${index + 1} has an invalid size.`);
    const ext = path.extname(source).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : undefined;
    if (!mime) throw new Error(`Image ${index + 1} must be PNG, JPEG, GIF, or WebP.`);
    const target = path.join(root, `${crypto.randomUUID()}${ext}`);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    const body = fs.readFileSync(target);
    return { path: target, name: path.basename(source), mime_type: mime, size: body.length, sha256: `sha256:${crypto.createHash("sha256").update(body).digest("hex")}` };
  });
}

const prep = program.command("prepare").description("Create one encrypted draft; never publishes");
prep.command("reddit-post")
  .requiredOption("--subreddit <name>")
  .requiredOption("--title <text>")
  .option("--body <text>")
  .option("--body-file <path>")
  .option("--url <url>")
  .option("--flair <visible-name>")
  .option("--image <path...>", "attach 1-4 local images")
  .option("--account <id>", "account", "default")
  .action(o => call("prepare", { input:{adapter:"reddit",account:o.account,action:"create_post",target:{subreddit:o.subreddit},content:{title:o.title,body:text(o.body,o.bodyFile),url:o.url,flair:o.flair,media_files:localImages(o.image)},owner_command:true} }));

prep.command("reddit-comment")
  .requiredOption("--target <exact-reddit-permalink>")
  .option("--body <text>")
  .option("--body-file <path>")
  .option("--account <id>", "account", "default")
  .action(o => call("prepare", { input:{adapter:"reddit",account:o.account,action:"create_comment",target:{url:o.target},content:{body:text(o.body,o.bodyFile)},owner_command:true} }));

program.command("edit")
  .requiredOption("--target <exact-reddit-permalink>")
  .option("--body <text>")
  .option("--body-file <path>")
  .option("--account <id>", "account", "default")
  .action(o => call("prepare", { input:{adapter:"reddit",account:o.account,action:"edit",target:{url:o.target},content:{body:text(o.body,o.bodyFile)},owner_command:true} }));

program.command("delete")
  .requiredOption("--target <exact-reddit-permalink>")
  .option("--account <id>", "account", "default")
  .action(o => call("prepare", { input:{adapter:"reddit",account:o.account,action:"delete",target:{url:o.target},content:{},owner_command:true} }));

program.command("preview <draft-id>").action(id => call("preview", { draft_id:id }));
program.command("approve <draft-id>")
  .requiredOption("--digest <sha256>")
  .description("Owner-only interactive approval; requires a real TTY")
  .action(async(id,o)=>{ if(!process.stdin.isTTY) throw new Error("Approval requires an interactive TTY."); const rl=createInterface({input:process.stdin,output:process.stderr}); const confirmation=await rl.question(`Type exactly APPROVE ${id}: `); rl.close(); await call("approve",{draft_id:id,preview_digest:o.digest,confirmation}); });
program.command("publish <draft-id>").requiredOption("--approval <token>").action((id,o) => call("publish", { draft_id:id,approval_token:o.approval }));
program.command("login").option("--account <id>", "account", "default").action(o => call("login", { adapter:"reddit",account:o.account }));
program.command("status").option("--account <id>", "account", "default").action(o => call("status", { adapter:"reddit",account:o.account }));
program.command("pending").action(() => call("pending"));
program.command("reddit-rules <subreddit>").option("--account <id>", "account", "default").action((subreddit,o) => call("reddit_rules", {subreddit,account:o.account}));
program.command("reddit-flairs <subreddit>").option("--account <id>", "account", "default").action((subreddit,o) => call("reddit_flairs", {subreddit,account:o.account}));
program.command("doctor").option("--live", "read-only live checks").action(o => call("diagnose", { live:o.live }));
program.parseAsync().catch(e => { console.error(e.message); process.exit(1); });

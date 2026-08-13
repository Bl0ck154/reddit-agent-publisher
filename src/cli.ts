#!/usr/bin/env node
import fs from "node:fs";
import { Command } from "commander";
import { ensureState, loadConfig } from "./config.js";
import { PublisherService } from "./service.js";

const config = loadConfig();
ensureState(config);
const publisher = new PublisherService(config);
const program = new Command();

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function text(file?: string, inline?: string): string {
  if (file) return fs.readFileSync(file, "utf8");
  return inline ?? "";
}

program.name("pubctl").description("Reddit Agent Publisher CLI").version("0.1.0");

program.command("login")
  .option("--account <account>", "browser profile", "default")
  .action(async ({ account }) => print(await publisher.login(account)));

program.command("status")
  .option("--account <account>", "browser profile", "default")
  .action(async ({ account }) => print(await publisher.status(account)));

program.command("rules")
  .argument("<subreddit>")
  .option("--account <account>", "browser profile", "default")
  .action(async (subreddit, { account }) => print(await publisher.rules(account, subreddit)));

program.command("flairs")
  .argument("<subreddit>")
  .option("--account <account>", "browser profile", "default")
  .action(async (subreddit, { account }) => print(await publisher.flairs(account, subreddit)));

program.command("prepare-post")
  .requiredOption("--subreddit <name>")
  .requiredOption("--title <title>")
  .option("--body <text>")
  .option("--body-file <path>")
  .option("--url <url>")
  .option("--flair <name>")
  .option("--image <path...>")
  .option("--account <account>", "browser profile", "default")
  .action(async (options) => {
    const content: Record<string, unknown> = { title: options.title };
    const body = text(options.bodyFile, options.body);
    if (body) content.body = body;
    if (options.url) content.url = options.url;
    if (options.flair) content.flair = options.flair;
    if (options.image?.length) content.media_files = options.image;
    print(await publisher.prepare({
      adapter: "reddit",
      account: options.account,
      action: "create_post",
      target: { subreddit: options.subreddit },
      content,
      owner_command: true
    }));
  });

program.command("prepare-comment")
  .requiredOption("--url <permalink>")
  .option("--body <text>")
  .option("--body-file <path>")
  .option("--account <account>", "browser profile", "default")
  .action(async (options) => print(await publisher.prepare({
    adapter: "reddit",
    account: options.account,
    action: "create_comment",
    target: { url: options.url },
    content: { body: text(options.bodyFile, options.body) },
    owner_command: true
  })));

program.command("prepare-edit")
  .requiredOption("--url <permalink>")
  .option("--body <text>")
  .option("--body-file <path>")
  .option("--account <account>", "browser profile", "default")
  .action(async (options) => print(await publisher.prepare({
    adapter: "reddit",
    account: options.account,
    action: "edit",
    target: { url: options.url },
    content: { body: text(options.bodyFile, options.body) },
    owner_command: true
  })));

program.command("prepare-delete")
  .requiredOption("--url <permalink>")
  .option("--account <account>", "browser profile", "default")
  .action(async (options) => print(await publisher.prepare({
    adapter: "reddit",
    account: options.account,
    action: "delete",
    target: { url: options.url },
    content: {},
    owner_command: true
  })));

program.command("preview")
  .argument("<draftId>")
  .action(async (draftId) => print(await publisher.preview(draftId)));

program.command("approve")
  .argument("<draftId>")
  .requiredOption("--digest <sha256>")
  .action(async (draftId, { digest }) => print(await publisher.approve(draftId, digest, `APPROVE ${draftId}`)));

program.command("publish")
  .argument("<draftId>")
  .requiredOption("--approval <token>")
  .action(async (draftId, { approval }) => print(await publisher.publish(draftId, approval)));

program.command("pending")
  .action(async () => print(await publisher.pending()));

program.command("doctor")
  .option("--live", "include a live Reddit reachability check", false)
  .action(async ({ live }) => print(await publisher.diagnose(Boolean(live))));

await program.parseAsync(process.argv);

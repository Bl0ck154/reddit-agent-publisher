import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approvedCommentFieldAction, canonicalRedditPublishedPostUrl, detectRedditTargetUnavailableText, extractCommunityRulesText, formatSubredditRulesPayload, inferRedditBodyFormat, normalizeFlairOptions, redditCommentControlMatchesTarget, RedditBrowserAdapter, resolveRedditBodyFormat } from "../adapters/reddit-browser.js";
import type { Config } from "../config.js";
import type { Draft } from "../types.js";

const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),"reddit-adapter-"));
const config:Config={
  stateDir,
  socketPath:path.join(stateDir,"sock"),
  chromePath:"/missing",
  display:":98",
  approvalTtlSeconds:900,
  mutationCooldownSeconds:15,
  browserIdleSeconds:90,
  redditMetadataCacheSeconds:900,
  actionsHost:"127.0.0.1",
  actionsPort:8791,
  defaultAccount:"owner-main",
  browserServicePrefix:"reddit-agent-publisher-browser",
  cdpUrl:"http://127.0.0.1:9222",
};
const base={id:"1",adapter:"reddit",account:"default",state:"PREPARED",revision:1,digest:"x",created_at:"x",updated_at:"x"} as const;

test("Reddit browser adapter validates without API credentials",async()=>{
  const a=new RedditBrowserAdapter(config);
  await a.validate({...base,action:"create_post",target:{subreddit:"example"},content:{title:"Owner post",body:"Draft"}} as Draft);
});

test("Reddit browser adapter rejects arbitrary local image paths",async()=>{
  const outside=path.join(config.stateDir,"outside.png");
  fs.writeFileSync(outside,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const a=new RedditBrowserAdapter(config);
  await assert.rejects(()=>a.validate({...base,action:"create_post",target:{subreddit:"example"},content:{title:"Owner image post",media_files:[{path:outside,mime_type:"image/png"}]}} as Draft),/protected publisher media directory/);
});

test("Reddit browser adapter accepts prepared CLI images from the protected local-files directory",async()=>{
  const root=path.join(config.stateDir,"artifacts","local-files");
  fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,"image.png");
  const bytes=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  fs.writeFileSync(file,bytes);
  const a=new RedditBrowserAdapter(config);
  await a.validate({...base,action:"create_post",target:{subreddit:"example"},content:{title:"Owner image post",media_files:[{path:file,name:"image.png",mime_type:"image/png",size:bytes.length,sha256:`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`}]}} as Draft);
});

test("Reddit browser adapter rejects look-alike URLs",async()=>{
  const a=new RedditBrowserAdapter(config);
  await assert.rejects(()=>a.validate({...base,action:"create_comment",target:{url:"https://reddit.com.evil.invalid/r/x"},content:{body:"x"}} as Draft),/canonical HTTPS Reddit/);
});

test("Reddit browser adapter accepts canonical comment permalink",async()=>{
  const a=new RedditBrowserAdapter(config);
  await a.validate({...base,action:"create_comment",target:{url:"https://www.reddit.com/r/example/comments/abc123/title/def456/"},content:{body:"Owner reply"}} as Draft);
});
test("Reddit browser adapter validates an exact Reddit Chat room reply",async()=>{
  const a=new RedditBrowserAdapter(config); await a.validate({...base,action:"send_chat_message",target:{room_id:"!room123:reddit.com"},content:{body:"Owner DM reply"}} as Draft);
});
test("Reddit browser adapter validates a verified username direct-message target",async()=>{
  const a=new RedditBrowserAdapter(config); await a.validate({...base,action:"send_chat_message",target:{recipient_username:"TopCommenter",recipient_fullname:"t2_abc123"},content:{body:"Owner DM"}} as Draft);
});
test("Reddit browser adapter validates a media-only Reddit Chat attachment from protected storage",async()=>{
  const dir=path.join(config.stateDir,"artifacts","local-files"); fs.mkdirSync(dir,{recursive:true}); const file=path.join(dir,"owner.pdf"); fs.writeFileSync(file,"pdf");
  const a=new RedditBrowserAdapter(config); await a.validate({...base,adapter:"reddit",action:"send_chat_message",target:{room_id:"!room123:reddit.com"},content:{body:"",media_files:[{path:file,name:"owner.pdf",mime_type:"application/pdf",size:3,sha256:"sha256:test"}]}} as Draft);
});
test("Reddit browser adapter rejects a Chat attachment outside protected media storage",async()=>{
  const file=path.join(config.stateDir,"outside-chat.pdf"); fs.writeFileSync(file,"pdf"); const a=new RedditBrowserAdapter(config);
  await assert.rejects(()=>a.validate({...base,adapter:"reddit",action:"send_chat_message",target:{room_id:"!room123:reddit.com"},content:{media_files:[{path:file,name:"outside-chat.pdf",mime_type:"application/pdf",size:3,sha256:"sha256:x"}]}} as Draft),/protected publisher media directory/);
});
test("Reddit browser adapter rejects invented non-Reddit Chat room ids",async()=>{
  const a=new RedditBrowserAdapter(config); await assert.rejects(()=>a.validate({...base,action:"send_chat_message",target:{room_id:"!room123:evil.invalid"},content:{body:"x"}} as Draft),/valid Reddit Chat room_id/);
});

test("Reddit browser adapter rejects arbitrary Reddit paths for mutations",async()=>{
  const a=new RedditBrowserAdapter(config);
  await assert.rejects(()=>a.validate({...base,action:"delete",target:{url:"https://www.reddit.com/settings/account"},content:{}} as Draft),/canonical post\/comment permalink/);
});

test("Reddit rules fallback extracts the dedicated mod-page content",()=>{
  const text=extractCommunityRulesText("reddit\nSearch\nCommunity Rules\nNAME\n1\nBe Civil.\nCREATED\nNov 12, 2023");
  assert.equal(text,"Community Rules\nNAME\n1\nBe Civil.\nCREATED\nNov 12, 2023");
  assert.equal(extractCommunityRulesText("Create post\nNo rules here"),undefined);
});

test("Reddit rules API payload is formatted without depending on mod UI",()=>{
  assert.deepEqual(formatSubredditRulesPayload({rules:[]}),{text:"Community Rules\nNo subreddit-specific rules are listed.",rules:[]});
  const formatted=formatSubredditRulesPayload({rules:[
    {short_name:"No Spam",description:"Do not spam.",kind:"all",priority:1},
    {short_name:"Posts only",description:"Stay on topic.",kind:"link",priority:0},
  ]});
  assert.equal(formatted?.text,"Community Rules\n\n1. Posts only\nApplies to: Posts\nStay on topic.\n\n2. No Spam\nApplies to: Posts & comments\nDo not spam.");
  assert.deepEqual(formatted?.rules.map(rule=>rule.short_name),["Posts only","No Spam"]);
  assert.equal(formatSubredditRulesPayload({site_rules:[]}),undefined);
});

test("Reddit flair options are normalized and deduplicated",()=>{
  assert.deepEqual(normalizeFlairOptions([" Question ","News\n","question","","Support"]),["Question","News","Support"]);
});

test("Reddit publish redirect is converted to a stable post permalink",()=>{
  assert.deepEqual(canonicalRedditPublishedPostUrl("https://www.reddit.com/r/Telegram/?created=t3_1vvgd46&createdPostType=text&is_eligible_for_nudge_to_crosspost_modal=true","Telegram"),{url:"https://www.reddit.com/r/Telegram/comments/1vvgd46/",fullname:"t3_1vvgd46"});
});

test("Reddit direct post URL is canonicalized and tracking query is removed",()=>{
  assert.deepEqual(canonicalRedditPublishedPostUrl("https://www.reddit.com/r/Telegram/comments/1vvgd46/some_title/?utm_source=chatgpt.com","Telegram"),{url:"https://www.reddit.com/r/Telegram/comments/1vvgd46/",fullname:"t3_1vvgd46"});
  assert.equal(canonicalRedditPublishedPostUrl("https://example.com/?created=t3_1vvgd46","Telegram"),undefined);
});

test("Reddit unavailable-page text is classified separately from UI changes",()=>{
  assert.equal(detectRedditTargetUnavailableText("Page not found\nExplore Reddit Communities"),"page_not_found");
  assert.equal(detectRedditTargetUnavailableText("This post was deleted by the person who originally posted it."),"deleted");
  assert.equal(detectRedditTargetUnavailableText("Normal live Reddit post"),undefined);
});

test("Reddit body_format supports auto detection and rejects unknown modes",async()=>{
  const a=new RedditBrowserAdapter(config);
  await a.validate({...base,adapter:"reddit",action:"create_comment",target:{url:"https://www.reddit.com/r/example/comments/abc123/title/"},content:{body:"**bold**",body_format:"markdown"}} as Draft);
  await a.validate({...base,adapter:"reddit",action:"create_comment",target:{url:"https://www.reddit.com/r/example/comments/abc123/title/"},content:{body:"**bold**",body_format:"auto"}} as Draft);
  await assert.rejects(()=>a.validate({...base,adapter:"reddit",action:"create_comment",target:{url:"https://www.reddit.com/r/example/comments/abc123/title/"},content:{body:"x",body_format:"html"}} as Draft),/body_format must be auto, plain or markdown/);
  const plainSamples = [
    "Normal text",
    "\\*\\*literal stars\\*\\*",
    "__init__",
    "__name__ == \"__main__\"",
    "foo__bar__baz",
    "file_name__backup__2026",
    "2 ** 3",
    "a**b**c",
    "> 10",
    "line1\n> 10\nline3",
    "- 5 degrees",
    "line1\n- note\nline3",
    "# heading-looking text",
    "#hashtag",
    "x > 10",
    "C:\\path\\**\\file",
    "regex: ^foo.*bar$",
    "price ~~ old ~~ maybe",
    "some__token__value",
  ];
  for (const sample of plainSamples) assert.equal(inferRedditBodyFormat(sample),"plain",sample);

  const markdownSamples = [
    "Make **this part** bold",
    "**bold**",
    "Make *this part* italic",
    "Use ~~strike~~ here",
    "[OpenAI](https://openai.com)",
    "```js\nconsole.log('x')\n```",
    "Hide >!spoiler!< please",
  ];
  for (const sample of markdownSamples) assert.equal(inferRedditBodyFormat(sample),"markdown",sample);

  assert.equal(resolveRedditBodyFormat(undefined,"Make **this part** bold"),"markdown");
  assert.throws(()=>resolveRedditBodyFormat("plain","Make **this part** bold"),/REDDIT_BODY_FORMAT_CONFLICT|conflicts with high-confidence Markdown markers/);
  assert.equal(resolveRedditBodyFormat("plain","__init__"),"plain");
  assert.equal(resolveRedditBodyFormat("plain","Normal text"),"plain");
  assert.equal(resolveRedditBodyFormat("plain","\\*\\*literal stars\\*\\*"),"plain");
  assert.equal(resolveRedditBodyFormat("markdown","Normal text"),"markdown");
});


test("Reddit reply controls are bound to the exact target comment, not nested replies",()=>{
  assert.equal(redditCommentControlMatchesTarget("t1_p6exuss","t1_p6exuss"),true);
  assert.equal(redditCommentControlMatchesTarget("t1_p6gz5h8","t1_p6exuss"),false);
  assert.equal(redditCommentControlMatchesTarget(undefined,"t1_p6exuss"),false);
});


test("Reddit approved reply restores a disappeared or reset composer without accepting changed text",()=>{
  assert.equal(approvedCommentFieldAction("approved body","approved body"),"keep");
  assert.equal(approvedCommentFieldAction("","approved body"),"restore");
  assert.equal(approvedCommentFieldAction(undefined,"approved body"),"restore");
  assert.equal(approvedCommentFieldAction("different body","approved body"),"stale");
});

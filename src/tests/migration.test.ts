import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { Store } from "../db.js";

process.env.NODE_ENV = "test";

function config(stateDir:string):Config {
  return {
    stateDir,
    socketPath:path.join(stateDir,"publisher.sock"),
    chromePath:"/missing/chrome",
    display:":98",
    approvalTtlSeconds:900,
    mutationCooldownSeconds:0,
    browserIdleSeconds:90,
    redditMetadataCacheSeconds:900,
    actionsHost:"127.0.0.1",
    actionsPort:8791,
    defaultAccount:"owner-main",
    browserServicePrefix:"reddit-agent-publisher-browser",
    cdpUrl:"http://127.0.0.1:9222",
  };
}

test("v0.1.x plaintext draft database migrates in place to encrypted payload storage",()=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),"reddit-publisher-migration-"));
  const dbPath=path.join(stateDir,"publisher.sqlite");
  const legacy=new Database(dbPath);
  legacy.exec(`
    CREATE TABLE drafts (
      id TEXT PRIMARY KEY, adapter TEXT NOT NULL, account TEXT NOT NULL,
      action TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
      revision INTEGER NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
      digest TEXT NOT NULL, token_hash TEXT NOT NULL, status TEXT NOT NULL,
      approved_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
    );
    CREATE TABLE previews (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
      digest TEXT NOT NULL, summary_json TEXT NOT NULL, artifact_path TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE publications (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, adapter TEXT NOT NULL, account TEXT NOT NULL,
      external_id TEXT, canonical_url TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, actor TEXT NOT NULL,
      draft_id TEXT, metadata_json TEXT NOT NULL, previous_hash TEXT, event_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const now=new Date().toISOString();
  legacy.prepare("INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "legacy-draft","reddit","owner-main","create_post",JSON.stringify({target:{subreddit:"test"},content:{title:"legacy title",body:"legacy body"}}),"PREPARED",1,"sha256:legacy",now,now,
  );
  legacy.close();

  const store=new Store(config(stateDir));
  const migrated=store.getDraft("legacy-draft");
  assert.equal(migrated?.content.title,"legacy title");
  const row=store.db.prepare("SELECT payload_json,payload_ciphertext FROM drafts WHERE id=?").get("legacy-draft") as any;
  assert.equal(typeof row.payload_ciphertext,"string");
  assert.ok(row.payload_ciphertext.length>20);
  assert.deepEqual(JSON.parse(row.payload_json),{});
  const publicationColumns=(store.db.pragma("table_info(publications)") as Array<{name:string}>).map(row=>row.name);
  assert.ok(publicationColumns.includes("metadata_ciphertext"));
  store.db.close();
  fs.rmSync(stateDir,{recursive:true,force:true});
});

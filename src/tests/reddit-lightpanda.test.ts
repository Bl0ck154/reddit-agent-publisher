import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ExternalRedditLightpanda } from "../external-reddit-lightpanda.js";
import { seal } from "../crypto-store.js";
import { loadConfig, type Config } from "../config.js";

test("Lightpanda credentials are isolated from legacy Reddit snapshots", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"reddit-lightpanda-test-"));
  const previousNodeEnv=process.env.NODE_ENV;
  const previousKeyFile=process.env.PUBLISHER_MASTER_KEY_FILE;
  try {
    process.env.NODE_ENV="test";
    delete process.env.PUBLISHER_MASTER_KEY_FILE;
    const config={stateDir:root} as Config;
    const lightpanda=new ExternalRedditLightpanda(config);
    const legacy=path.join(root,"auth","reddit");
    fs.mkdirSync(legacy,{recursive:true});
    const sample=[{name:"reddit_session",value:"synthetic-value",domain:".reddit.com",path:"/",expires:0,httpOnly:true,secure:true,sameSite:"Lax"}];
    fs.writeFileSync(path.join(legacy,"owner-main.cookies.enc"),seal(sample));
    assert.equal(lightpanda.hasAuthSnapshot("owner-main"),false);
    const dest=path.join(root,"auth","lightpanda","owner-main.cookies.enc");
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,seal(sample));
    assert.equal(lightpanda.hasAuthSnapshot("owner-main"),true);
  } finally {
    if (previousNodeEnv===undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV=previousNodeEnv;
    if (previousKeyFile===undefined) delete process.env.PUBLISHER_MASTER_KEY_FILE;
    else process.env.PUBLISHER_MASTER_KEY_FILE=previousKeyFile;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test("Lightpanda is an explicit optional Reddit browser mode",()=>{
 const was=process.env.PUBLISHER_REDDIT_BROWSER;
 try {
   process.env.PUBLISHER_REDDIT_BROWSER="lightpanda";
   assert.equal(loadConfig().redditBrowser,"lightpanda");
   process.env.PUBLISHER_REDDIT_BROWSER="invalid-backend";
   assert.equal(loadConfig().redditBrowser,"chrome");
 } finally {
   if(was===undefined)delete process.env.PUBLISHER_REDDIT_BROWSER;
   else process.env.PUBLISHER_REDDIT_BROWSER=was;
 }
});

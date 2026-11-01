import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ExternalRedditObscura } from "../external-reddit-obscura.js";
import { seal } from "../crypto-store.js";
import { loadConfig, type Config } from "../config.js";

test("Lightpanda session is isolated from Obscura and Chrome authentication", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"reddit-lightpanda-test-"));
  const current=process.env.NODE_ENV;
  try {
    process.env.NODE_ENV="test";
    const source=path.join(root,"auth","reddit");
    fs.mkdirSync(source,{recursive:true});
    const sample=[{name:"reddit_session",value:"synthetic-value",domain:".reddit.com",path:"/",expires:0,httpOnly:true,secure:true,sameSite:"Lax"}];
    fs.writeFileSync(path.join(source,"owner-main.cookies.enc"),seal(sample));
    const config={stateDir:root} as Config;
    const obscura=new ExternalRedditObscura(config);
    const lightpanda=new ExternalRedditObscura(config,"lightpanda");
    assert.equal(obscura.hasAuthSnapshot("owner-main"),true);
    assert.equal(lightpanda.hasAuthSnapshot("owner-main"),false);
    const destination=path.join(root,"auth","lightpanda","owner-main.cookies.enc");
    fs.writeFileSync(destination,seal(sample));
    assert.equal(lightpanda.hasAuthSnapshot("owner-main"),true);
    assert.equal(obscura.hasAuthSnapshot("owner-main"),true);
  } finally {
    if(current===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=current;
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

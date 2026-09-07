import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { rpc } from "./rpc.js";

export type SetupMode = "auto" | "desktop" | "server";
export type SetupClient = "codex" | "claude" | "opencode" | "generic";
export interface SetupOptions { mode?:SetupMode; client?:SetupClient; account?:string; stateDir?:string; systemd?:boolean; runtimeInstall?:boolean; interactive?:boolean; }
type RuntimeInstall={packageRoot:string;stable:boolean;warning?:string};
type SystemdInstall={installed:boolean;serverDesktop:boolean;vncAvailable:boolean;warning?:string};

const NAME="reddit-agent-publisher";
const BROWSER_SERVICE="reddit-agent-publisher-browser";
const DAEMON_SERVICE="reddit-agent-publisher.service";
const XVFB_SERVICE="reddit-agent-publisher-xvfb.service";
const VNC_SERVICE="reddit-agent-publisher-vnc.service";

export function defaultStateDir():string { return process.env.PUBLISHER_STATE_DIR ?? path.join(os.homedir(),".local","share",NAME); }
export function sanitizeAccountId(value:string):string { const v=value.trim().replace(/[^a-z0-9_-]/gi,"_"); if(!v)throw new Error("Account id cannot be empty"); return v; }
export function resolveSetupMode(mode:SetupMode="auto",env:NodeJS.ProcessEnv=process.env,platform=process.platform):Exclude<SetupMode,"auto"> { if(mode!=="auto")return mode; return platform==="darwin"||platform==="win32"||Boolean(env.DISPLAY||env.WAYLAND_DISPLAY)?"desktop":"server"; }

function commandPath(name:string):string|undefined { const r=spawnSync(process.platform==="win32"?"where":"which",[name],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}); return r.status===0?String(r.stdout??"").split(/\r?\n/).map(x=>x.trim()).find(Boolean):undefined; }
export function detectChrome():string|undefined {
  if(process.env.PUBLISHER_CHROME&&fs.existsSync(process.env.PUBLISHER_CHROME))return process.env.PUBLISHER_CHROME;
  for(const name of ["google-chrome","google-chrome-stable","chromium","chromium-browser"]){const p=commandPath(name);if(p)return p;}
  const candidates=process.platform==="darwin"?["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Chromium.app/Contents/MacOS/Chromium"]:process.platform==="win32"?[
    path.join(process.env.PROGRAMFILES??"C:\\Program Files","Google","Chrome","Application","chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"]??"C:\\Program Files (x86)","Google","Chrome","Application","chrome.exe")
  ]:["/opt/google/chrome/google-chrome","/usr/bin/google-chrome","/usr/bin/chromium"];
  return candidates.find(fs.existsSync);
}

export function ensureMasterKey(stateDir:string):string {
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700}); fs.chmodSync(stateDir,0o700);
  const p=path.join(stateDir,"master.key"); if(!fs.existsSync(p))fs.writeFileSync(p,crypto.randomBytes(32),{mode:0o600,flag:"wx"}); fs.chmodSync(p,0o600); return p;
}
function writeJson(file:string,value:unknown):void { fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); const tmp=`${file}.${process.pid}.tmp`; fs.writeFileSync(tmp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600}); fs.renameSync(tmp,file); fs.chmodSync(file,0o600); }
function writeConfig(stateDir:string,chromePath:string,account:string,display:string,cdpUrl?:string):void {
  const p=path.join(stateDir,"config.json"); let old:Record<string,unknown>={};
  if(fs.existsSync(p)){try{old=JSON.parse(fs.readFileSync(p,"utf8"));}catch{throw new Error(`Existing config is not valid JSON: ${p}`);}}
  const next:Record<string,unknown>={...old,chromePath,display,defaultAccount:account,browserServicePrefix:BROWSER_SERVICE}; if(cdpUrl)next.cdpUrl=cdpUrl;else delete next.cdpUrl; writeJson(p,next);
}

function sourceRoot():string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."); }
function installRuntime(root:string,stateDir:string):RuntimeInstall {
  const npm=commandPath(process.platform==="win32"?"npm.cmd":"npm")??commandPath("npm"); if(!npm)return{packageRoot:root,stable:false,warning:"npm was not found; using the current package path."};
  const tmp=path.join(stateDir,"tmp","setup-pack"),prefix=path.join(stateDir,"runtime"); fs.rmSync(tmp,{recursive:true,force:true}); fs.mkdirSync(tmp,{recursive:true,mode:0o700}); fs.mkdirSync(prefix,{recursive:true,mode:0o700});
  const pack=spawnSync(npm,["pack",root,"--ignore-scripts","--pack-destination",tmp],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  const archiveName=String(pack.stdout??"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean).at(-1); if(pack.status!==0||!archiveName)return{packageRoot:root,stable:false,warning:`Could not pack stable runtime: ${String(pack.stderr??"npm pack failed").trim()}`};
  const install=spawnSync(npm,["install","--prefix",prefix,"--omit=dev","--no-audit","--no-fund","--ignore-scripts",path.join(tmp,archiveName)],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  const installed=path.join(prefix,"node_modules",NAME); if(install.status!==0||!fs.existsSync(path.join(installed,"dist","daemon.js")))return{packageRoot:root,stable:false,warning:`Could not install stable runtime: ${String(install.stderr??"runtime install failed").trim()}`};
  fs.rmSync(tmp,{recursive:true,force:true}); return{packageRoot:installed,stable:true};
}

function q(v:string):string{return `"${v.replace(/%/g,"%%").replace(/\\/g,"\\\\").replace(/"/g,'\\"')}"`;}
function env(name:string,value:string):string{return `Environment=${q(`${name}=${value}`)}`;}
export function renderSystemdUnits(a:{runtimeRoot:string;stateDir:string;keyPath:string;chromePath:string;display:string;serverMode:boolean;xvfbPath?:string;x11vncPath?:string}):Record<string,string>{
  const needs=a.serverMode&&a.xvfbPath?`Requires=${XVFB_SERVICE}\nAfter=${XVFB_SERVICE}\n`:"";
  const units:Record<string,string>={
    [DAEMON_SERVICE]:`[Unit]\nDescription=Reddit Agent Publisher daemon\nAfter=network.target\n\n[Service]\nType=simple\n${env("PUBLISHER_STATE_DIR",a.stateDir)}\n${env("PUBLISHER_MASTER_KEY_FILE",a.keyPath)}\nExecStart=${q(process.execPath)} ${q(path.join(a.runtimeRoot,"dist","daemon.js"))}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`,
    [`${BROWSER_SERVICE}@.service`]:`[Unit]\nDescription=Reddit Agent Publisher browser (%i)\n${needs}\n[Service]\nType=simple\n${env("PUBLISHER_STATE_DIR",a.stateDir)}\n${env("PUBLISHER_CHROME",a.chromePath)}\n${env("DISPLAY",a.display)}\nPassEnvironment=WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS\nExecStart=/bin/sh ${q(path.join(a.runtimeRoot,"bin","start-browser"))} %i\nRestart=no\nTimeoutStopSec=10\n`
  };
  if(a.serverMode&&a.xvfbPath)units[XVFB_SERVICE]=`[Unit]\nDescription=Reddit Agent Publisher private Xvfb desktop\n\n[Service]\nType=simple\nExecStart=${q(a.xvfbPath)} ${a.display} -screen 0 1440x900x24 -nolisten tcp\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
  if(a.serverMode&&a.xvfbPath&&a.x11vncPath)units[VNC_SERVICE]=`[Unit]\nDescription=Reddit Agent Publisher localhost-only VNC\nRequires=${XVFB_SERVICE}\nAfter=${XVFB_SERVICE}\n\n[Service]\nType=simple\nExecStart=${q(a.x11vncPath)} -display ${a.display} -localhost -forever -shared -nopw -rfbport 5901\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
  return units;
}
function systemdEnv():NodeJS.ProcessEnv{const uid=typeof process.getuid==="function"?process.getuid():1000,runtime=process.env.XDG_RUNTIME_DIR??`/run/user/${uid}`;return{...process.env,XDG_RUNTIME_DIR:runtime,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS??`unix:path=${runtime}/bus`};}
function systemctl(args:string[]):{ok:boolean;error?:string}{const r=spawnSync("systemctl",["--user",...args],{encoding:"utf8",env:systemdEnv(),stdio:["ignore","pipe","pipe"]});return r.status===0?{ok:true}:{ok:false,error:String(r.stderr??r.stdout??"systemctl failed").trim()};}
function installSystemd(a:{runtimeRoot:string;stateDir:string;keyPath:string;chromePath:string;display:string;serverMode:boolean}):SystemdInstall{
  if(process.platform!=="linux"||!commandPath("systemctl"))return{installed:false,serverDesktop:false,vncAvailable:false,warning:"systemd user services are unavailable."};
  const probe=systemctl(["show-environment"]);if(!probe.ok)return{installed:false,serverDesktop:false,vncAvailable:false,warning:`systemd user session is unavailable: ${probe.error}`};
  const xvfbPath=a.serverMode?commandPath("Xvfb"):undefined,x11vncPath=a.serverMode?commandPath("x11vnc"):undefined,units=renderSystemdUnits({...a,xvfbPath,x11vncPath});
  const dir=path.join(process.env.XDG_CONFIG_HOME??path.join(os.homedir(),".config"),"systemd","user");fs.mkdirSync(dir,{recursive:true,mode:0o700});for(const[name,body]of Object.entries(units))fs.writeFileSync(path.join(dir,name),body,{mode:0o600});
  const reload=systemctl(["daemon-reload"]);if(!reload.ok)return{installed:false,serverDesktop:Boolean(xvfbPath),vncAvailable:Boolean(xvfbPath&&x11vncPath),warning:reload.error};
  if(a.serverMode&&xvfbPath)systemctl(["enable","--now",XVFB_SERVICE]);if(a.serverMode&&xvfbPath&&x11vncPath)systemctl(["enable","--now",VNC_SERVICE]);
  const start=systemctl(["enable","--now",DAEMON_SERVICE]);return start.ok?{installed:true,serverDesktop:!a.serverMode||Boolean(xvfbPath),vncAvailable:Boolean(xvfbPath&&x11vncPath)}:{installed:false,serverDesktop:Boolean(xvfbPath),vncAvailable:Boolean(xvfbPath&&x11vncPath),warning:start.error};
}

function portFor(account:string):number{return 9300+crypto.createHash("sha256").update(account).digest().readUInt16BE(0)%500;}
function startPortableChrome(chrome:string,stateDir:string,account:string):string{const port=portFor(account),profile=path.join(stateDir,"profiles",account);fs.mkdirSync(profile,{recursive:true,mode:0o700});const p=spawn(chrome,[`--user-data-dir=${profile}`,"--remote-debugging-address=127.0.0.1",`--remote-debugging-port=${port}`,"--no-first-run","--no-default-browser-check","about:blank"],{detached:true,stdio:"ignore",env:process.env});p.unref();return`http://127.0.0.1:${port}`;}
function startDaemon(runtimeRoot:string,stateDir:string,keyPath:string):void{const log=fs.openSync(path.join(stateDir,"publisherd.log"),"a",0o600),p=spawn(process.execPath,[path.join(runtimeRoot,"dist","daemon.js")],{detached:true,stdio:["ignore",log,log],env:{...process.env,PUBLISHER_STATE_DIR:stateDir,PUBLISHER_MASTER_KEY_FILE:keyPath}});p.unref();fs.closeSync(log);}
async function waitSocket(p:string,ms=8000):Promise<boolean>{const end=Date.now()+ms;while(Date.now()<end){if(fs.existsSync(p))return true;await new Promise(r=>setTimeout(r,200));}return false;}

export function buildMcpConfigs(runtimeRoot:string,stateDir:string):Record<SetupClient,string>{
  const command=process.execPath,mcpPath=path.join(runtimeRoot,"dist","mcp.js"),environment={PUBLISHER_STATE_DIR:stateDir};
  const generic=JSON.stringify({mcpServers:{"reddit-agent-publisher":{command,args:[mcpPath],env:environment}}},null,2);
  const opencode=JSON.stringify({mcp:{"reddit-agent-publisher":{type:"local",command:[command,mcpPath],enabled:true,environment}}},null,2);
  const codex=`[mcp_servers.reddit-agent-publisher]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(mcpPath)}]\nenv = { PUBLISHER_STATE_DIR = ${JSON.stringify(stateDir)} }\n`;
  return{codex,claude:generic,opencode,generic};
}
function writeMcpConfigs(runtimeRoot:string,stateDir:string):Record<SetupClient,string>{const configs=buildMcpConfigs(runtimeRoot,stateDir),dir=path.join(stateDir,"integrations"),paths={codex:path.join(dir,"codex.toml"),claude:path.join(dir,"claude-desktop.json"),opencode:path.join(dir,"opencode.json"),generic:path.join(dir,"mcp.json")};fs.mkdirSync(dir,{recursive:true,mode:0o700});for(const k of Object.keys(configs)as SetupClient[])fs.writeFileSync(paths[k],`${configs[k].trim()}\n`,{mode:0o600});return paths;}
async function login(socketPath:string,account:string,interactive:boolean):Promise<void>{
  try{const r=await rpc(socketPath,"login",{adapter:"reddit",account,actor:"setup"}),x=r.result as Record<string,unknown>|undefined;if(!r.ok){process.stderr.write(`• Reddit login could not open: ${r.error?.message}\n`);return;}if(x?.authenticated===true||x?.status==="AUTHENTICATED"){process.stderr.write("✓ Reddit session authenticated\n");return;}if(!interactive||!process.stdin.isTTY){process.stderr.write("• Reddit login is waiting in the owner-controlled browser.\n");return;}const rl=createInterface({input:process.stdin,output:process.stderr});await rl.question("Sign in to Reddit in the opened browser, then press Enter here to verify: ");rl.close();const s=await rpc(socketPath,"status",{adapter:"reddit",account,actor:"setup"}),sx=s.result as Record<string,unknown>|undefined;process.stderr.write(s.ok&&sx?.authenticated?"✓ Reddit session authenticated\n":"• Reddit session is not authenticated yet; rerun login/status after completing browser auth.\n");}catch(e){process.stderr.write(`• Login verification skipped: ${String((e as Error)?.message??e)}\n`);}
}

export async function runSetup(o:SetupOptions={}):Promise<void>{
  const stateDir=path.resolve(o.stateDir??defaultStateDir()),account=sanitizeAccountId(o.account??"owner-main"),mode=resolveSetupMode(o.mode??"auto"),serverMode=mode==="server",chrome=detectChrome();if(!chrome)throw new Error("Chrome/Chromium was not found. Install it or set PUBLISHER_CHROME, then rerun setup.");
  process.stderr.write(`Reddit Agent Publisher setup\n\n✓ Mode: ${mode}\n✓ Chrome: ${chrome}\n`);
  const keyPath=ensureMasterKey(stateDir),runtime=o.runtimeInstall===false?{packageRoot:sourceRoot(),stable:false}:installRuntime(sourceRoot(),stateDir),display=process.env.DISPLAY??(serverMode?":98":":0");
  process.stderr.write(`✓ Secure state: ${stateDir}\n✓ Encryption key ready\n${runtime.stable?"✓ Stable runtime installed":"• Using current runtime"}: ${runtime.packageRoot}\n`);if(runtime.warning)process.stderr.write(`  Warning: ${runtime.warning}\n`);

  // The daemon reads config once at process start, so persist it before starting any service.
  writeConfig(stateDir,chrome,account,display);
  let systemd:SystemdInstall={installed:false,serverDesktop:false,vncAvailable:false};if(o.systemd!==false)systemd=installSystemd({runtimeRoot:runtime.packageRoot,stateDir,keyPath,chromePath:chrome,display,serverMode});
  if(systemd.installed)process.stderr.write("✓ User services installed and publisher daemon started\n");
  else if(!serverMode){const cdp=startPortableChrome(chrome,stateDir,account);writeConfig(stateDir,chrome,account,display,cdp);startDaemon(runtime.packageRoot,stateDir,keyPath);process.stderr.write(`✓ Portable local Chrome started at ${cdp}\n✓ Publisher daemon started in the background\n`);if(systemd.warning)process.stderr.write(`  systemd not used: ${systemd.warning}\n`);}
  else{startDaemon(runtime.packageRoot,stateDir,keyPath);process.stderr.write("✓ Publisher daemon started in the background\n");if(systemd.warning)process.stderr.write(`  Warning: ${systemd.warning}\n`);}

  const integrations=writeMcpConfigs(runtime.packageRoot,stateDir);process.stderr.write(`✓ MCP configs generated: ${path.dirname(integrations.generic)}\n`);
  const socket=path.join(stateDir,"publisher.sock");if(await waitSocket(socket)){if(!serverMode||systemd.serverDesktop)await login(socket,account,o.interactive??true);}else process.stderr.write("  Warning: publisher daemon socket did not become ready; run reddit-agent-publisher doctor after setup.\n");
  process.stderr.write(`\nReady.\nMCP config (${o.client??"generic"}): ${integrations[o.client??"generic"]}\nState directory: ${stateDir}\n`);
  if(serverMode){if(systemd.vncAvailable)process.stderr.write("\nFor the one-time Reddit login:\n  ssh -N -L 5901:127.0.0.1:5901 YOUR_USER@YOUR_SERVER\nThen connect a VNC viewer to localhost:5901. VNC is bound to localhost only.\n");else if(!systemd.serverDesktop)process.stderr.write("\nHeadless login still needs a private desktop. Install Xvfb + x11vnc (or use your existing private VNC/desktop), rerun setup, and keep it localhost-only behind SSH.\n");else process.stderr.write("\nXvfb is ready, but x11vnc was not detected. Use your existing owner-controlled display access to complete Reddit login.\n");}
}

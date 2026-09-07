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

export interface SetupOptions {
  mode?: SetupMode;
  client?: SetupClient;
  account?: string;
  stateDir?: string;
  systemd?: boolean;
  runtimeInstall?: boolean;
  interactive?: boolean;
}

type RuntimeInstall = {
  packageRoot: string;
  stable: boolean;
  warning?: string;
};

type SystemdInstall = {
  installed: boolean;
  browserManaged: boolean;
  serverDesktop: boolean;
  vncAvailable: boolean;
  warning?: string;
};

const PACKAGE_NAME = "reddit-agent-publisher";
const BROWSER_SERVICE = "reddit-agent-publisher-browser";
const DAEMON_SERVICE = "reddit-agent-publisher.service";
const XVFB_SERVICE = "reddit-agent-publisher-xvfb.service";
const VNC_SERVICE = "reddit-agent-publisher-vnc.service";

export function defaultStateDir(): string {
  return process.env.PUBLISHER_STATE_DIR ?? path.join(os.homedir(), ".local", "share", PACKAGE_NAME);
}

export function sanitizeAccountId(value: string): string {
  const safe = value.trim().replace(/[^a-z0-9_-]/gi, "_");
  if (!safe) throw new Error("Account id cannot be empty");
  return safe;
}

export function resolveSetupMode(mode: SetupMode = "auto", env: NodeJS.ProcessEnv = process.env, platform = process.platform): Exclude<SetupMode, "auto"> {
  if (mode !== "auto") return mode;
  if (platform === "darwin" || platform === "win32" || env.DISPLAY || env.WAYLAND_DISPLAY) return "desktop";
  return "server";
}

function commandPath(command: string): string | undefined {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return undefined;
  return String(result.stdout ?? "").split(/\r?\n/).map(v => v.trim()).find(Boolean);
}

export function detectChrome(): string | undefined {
  if (process.env.PUBLISHER_CHROME && fs.existsSync(process.env.PUBLISHER_CHROME)) return process.env.PUBLISHER_CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = commandPath(name);
    if (found) return found;
  }
  const fixed = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : ["/opt/google/chrome/google-chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  return fixed.find(candidate => fs.existsSync(candidate));
}

export function ensureMasterKey(stateDir: string): string {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const keyPath = path.join(stateDir, "master.key");
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  fs.chmodSync(keyPath, 0o600);
  return keyPath;
}

function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function mergeConfig(stateDir: string, chromePath: string, account: string, display: string, cdpUrl?: string): string {
  const configPath = path.join(stateDir, "config.json");
  let current: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try { current = JSON.parse(fs.readFileSync(configPath, "utf8")); }
    catch { throw new Error(`Existing config is not valid JSON: ${configPath}`); }
  }
  const next: Record<string, unknown> = {
    ...current,
    chromePath,
    display,
    defaultAccount: account,
    browserServicePrefix: BROWSER_SERVICE,
  };
  if (cdpUrl) next.cdpUrl = cdpUrl;
  else delete next.cdpUrl;
  writeJsonAtomic(configPath, next);
  return configPath;
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function npmExecutable(): string | undefined {
  return commandPath(process.platform === "win32" ? "npm.cmd" : "npm") ?? commandPath("npm");
}

function stableRuntimeRoot(stateDir: string): string {
  return path.join(stateDir, "runtime", "node_modules", PACKAGE_NAME);
}

function installStableRuntime(sourceRoot: string, stateDir: string): RuntimeInstall {
  const npm = npmExecutable();
  if (!npm) return { packageRoot: sourceRoot, stable: false, warning: "npm was not found; services will use the current package path." };

  const tempDir = path.join(stateDir, "tmp", "setup-pack");
  const runtimeDir = path.join(stateDir, "runtime");
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const packed = spawnSync(npm, ["pack", sourceRoot, "--ignore-scripts", "--pack-destination", tempDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (packed.status !== 0) {
    return { packageRoot: sourceRoot, stable: false, warning: `Could not create stable runtime package: ${String(packed.stderr ?? "npm pack failed").trim()}` };
  }
  const archiveName = String(packed.stdout ?? "").split(/\r?\n/).map(v => v.trim()).filter(Boolean).at(-1);
  if (!archiveName) return { packageRoot: sourceRoot, stable: false, warning: "npm pack did not return an archive name; using current package path." };
  const archive = path.join(tempDir, archiveName);

  const installed = spawnSync(npm, ["install", "--prefix", runtimeDir, "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts", archive], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (installed.status !== 0) {
    return { packageRoot: sourceRoot, stable: false, warning: `Could not install stable runtime copy: ${String(installed.stderr ?? "npm install failed").trim()}` };
  }

  const root = stableRuntimeRoot(stateDir);
  if (!fs.existsSync(path.join(root, "dist", "daemon.js"))) {
    return { packageRoot: sourceRoot, stable: false, warning: "Stable runtime was installed but dist/daemon.js is missing; using current package path." };
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { packageRoot: root, stable: true };
}

function unitQuote(value: string): string {
  return `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unitEnv(name: string, value: string): string {
  return `Environment=${unitQuote(`${name}=${value}`)}`;
}

export function renderSystemdUnits(args: {
  runtimeRoot: string;
  stateDir: string;
  keyPath: string;
  chromePath: string;
  display: string;
  serverMode: boolean;
  xvfbPath?: string;
  x11vncPath?: string;
}): Record<string, string> {
  const daemon = `[Unit]\nDescription=Reddit Agent Publisher daemon\nAfter=network.target\n\n[Service]\nType=simple\n${unitEnv("PUBLISHER_STATE_DIR", args.stateDir)}\n${unitEnv("PUBLISHER_MASTER_KEY_FILE", args.keyPath)}\nExecStart=${unitQuote(process.execPath)} ${unitQuote(path.join(args.runtimeRoot, "dist", "daemon.js"))}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;

  const browserNeeds = args.serverMode && args.xvfbPath ? `Requires=${XVFB_SERVICE}\nAfter=${XVFB_SERVICE}\n` : "";
  const browser = `[Unit]\nDescription=Reddit Agent Publisher browser (%i)\n${browserNeeds}\n[Service]\nType=simple\n${unitEnv("PUBLISHER_STATE_DIR", args.stateDir)}\n${unitEnv("PUBLISHER_CHROME", args.chromePath)}\n${unitEnv("DISPLAY", args.display)}\nPassEnvironment=WAYLAND_DISPLAY XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS\nExecStart=/bin/sh ${unitQuote(path.join(args.runtimeRoot, "bin", "start-browser"))} %i\nRestart=no\nTimeoutStopSec=10\n\n`;

  const units: Record<string, string> = {
    [DAEMON_SERVICE]: daemon,
    [`${BROWSER_SERVICE}@.service`]: browser,
  };

  if (args.serverMode && args.xvfbPath) {
    units[XVFB_SERVICE] = `[Unit]\nDescription=Reddit Agent Publisher private Xvfb desktop\n\n[Service]\nType=simple\nExecStart=${unitQuote(args.xvfbPath)} ${args.display} -screen 0 1440x900x24 -nolisten tcp\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
  }
  if (args.serverMode && args.x11vncPath && args.xvfbPath) {
    units[VNC_SERVICE] = `[Unit]\nDescription=Reddit Agent Publisher localhost-only VNC\nRequires=${XVFB_SERVICE}\nAfter=${XVFB_SERVICE}\n\n[Service]\nType=simple\nExecStart=${unitQuote(args.x11vncPath)} -display ${args.display} -localhost -forever -shared -nopw -rfbport 5901\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
  }
  return units;
}

function userSystemdEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus`,
  };
}

function systemctl(args: string[]): { ok: boolean; error?: string } {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: userSystemdEnv(), stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? { ok: true } : { ok: false, error: String(result.stderr ?? result.stdout ?? "systemctl failed").trim() };
}

function installSystemd(args: {
  runtimeRoot: string;
  stateDir: string;
  keyPath: string;
  chromePath: string;
  display: string;
  serverMode: boolean;
}): SystemdInstall {
  if (process.platform !== "linux" || !commandPath("systemctl")) return { installed: false, browserManaged: false, serverDesktop: false, vncAvailable: false, warning: "systemd user services are unavailable." };

  const probe = systemctl(["show-environment"]);
  if (!probe.ok) return { installed: false, browserManaged: false, serverDesktop: false, vncAvailable: false, warning: `systemd user session is unavailable: ${probe.error}` };

  const xvfbPath = args.serverMode ? commandPath("Xvfb") : undefined;
  const x11vncPath = args.serverMode ? commandPath("x11vnc") : undefined;
  const units = renderSystemdUnits({ ...args, xvfbPath, x11vncPath });
  const unitDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(units)) fs.writeFileSync(path.join(unitDir, name), content, { mode: 0o600 });

  const reload = systemctl(["daemon-reload"]);
  if (!reload.ok) return { installed: false, browserManaged: false, serverDesktop: false, vncAvailable: false, warning: `systemctl daemon-reload failed: ${reload.error}` };
  const enableDaemon = systemctl(["enable", "--now", DAEMON_SERVICE]);
  if (!enableDaemon.ok) return { installed: false, browserManaged: true, serverDesktop: Boolean(xvfbPath), vncAvailable: Boolean(x11vncPath && xvfbPath), warning: `Publisher daemon service could not be started: ${enableDaemon.error}` };
  if (args.serverMode && xvfbPath) systemctl(["enable", "--now", XVFB_SERVICE]);
  if (args.serverMode && xvfbPath && x11vncPath) systemctl(["enable", "--now", VNC_SERVICE]);
  return { installed: true, browserManaged: true, serverDesktop: !args.serverMode || Boolean(xvfbPath), vncAvailable: Boolean(x11vncPath && xvfbPath) };
}

function portablePort(account: string): number {
  const digest = crypto.createHash("sha256").update(account).digest();
  return 9300 + digest.readUInt16BE(0) % 500;
}

function startPortableChrome(chromePath: string, stateDir: string, account: string, env: NodeJS.ProcessEnv = process.env): string {
  const port = portablePort(account);
  const profile = path.join(stateDir, "profiles", account);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const child = spawn(chromePath, [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { detached: true, stdio: "ignore", env });
  child.unref();
  return `http://127.0.0.1:${port}`;
}

function startDetachedDaemon(runtimeRoot: string, stateDir: string, keyPath: string): void {
  const log = fs.openSync(path.join(stateDir, "publisherd.log"), "a", 0o600);
  const child = spawn(process.execPath, [path.join(runtimeRoot, "dist", "daemon.js")], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PUBLISHER_STATE_DIR: stateDir, PUBLISHER_MASTER_KEY_FILE: keyPath },
  });
  child.unref();
  fs.closeSync(log);
}

async function waitForSocket(socketPath: string, timeoutMs = 8_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(socketPath)) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

export function buildMcpConfigs(runtimeRoot: string, stateDir: string): Record<SetupClient, string> {
  const command = process.execPath;
  const mcpPath = path.join(runtimeRoot, "dist", "mcp.js");
  const env = { PUBLISHER_STATE_DIR: stateDir };
  const generic = JSON.stringify({
    mcpServers: {
      "reddit-agent-publisher": { command, args: [mcpPath], env },
    },
  }, null, 2);
  const claude = generic;
  const opencode = JSON.stringify({
    mcp: {
      "reddit-agent-publisher": { type: "local", command: [command, mcpPath], enabled: true, environment: env },
    },
  }, null, 2);
  const tomlString = (value: string) => JSON.stringify(value);
  const codex = `[mcp_servers.reddit-agent-publisher]\ncommand = ${tomlString(command)}\nargs = [${tomlString(mcpPath)}]\nenv = { PUBLISHER_STATE_DIR = ${tomlString(stateDir)} }\n`;
  return { codex, claude, opencode, generic };
}

function writeMcpConfigs(runtimeRoot: string, stateDir: string): Record<SetupClient, string> {
  const configs = buildMcpConfigs(runtimeRoot, stateDir);
  const dir = path.join(stateDir, "integrations");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths: Record<SetupClient, string> = {
    codex: path.join(dir, "codex.toml"),
    claude: path.join(dir, "claude-desktop.json"),
    opencode: path.join(dir, "opencode.json"),
    generic: path.join(dir, "mcp.json"),
  };
  for (const client of Object.keys(configs) as SetupClient[]) fs.writeFileSync(paths[client], `${configs[client].trim()}\n`, { mode: 0o600 });
  return paths;
}

async function promptForLogin(socketPath: string, account: string, interactive: boolean): Promise<{ attempted: boolean; authenticated?: boolean; message?: string }> {
  try {
    const login = await rpc(socketPath, "login", { adapter: "reddit", account, actor: "setup" });
    const loginResult = login.result as Record<string, unknown> | undefined;
    if (!login.ok) return { attempted: true, message: login.error?.message ?? "Could not open Reddit login" };
    if (loginResult?.authenticated === true || loginResult?.status === "AUTHENTICATED") return { attempted: true, authenticated: true };
    if (!interactive || !process.stdin.isTTY) return { attempted: true, authenticated: false, message: "Reddit login is waiting in the owner-controlled browser." };

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    await rl.question("Sign in to Reddit in the opened browser, then press Enter here to verify: ");
    rl.close();
    const status = await rpc(socketPath, "status", { adapter: "reddit", account, actor: "setup" });
    const statusResult = status.result as Record<string, unknown> | undefined;
    return { attempted: true, authenticated: Boolean(status.ok && statusResult?.authenticated), message: status.ok ? undefined : status.error?.message };
  } catch (error) {
    return { attempted: false, message: String((error as Error)?.message ?? error) };
  }
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir());
  const account = sanitizeAccountId(options.account ?? "owner-main");
  const mode = resolveSetupMode(options.mode ?? "auto");
  const interactive = options.interactive ?? true;
  const chromePath = detectChrome();
  if (!chromePath) throw new Error("Chrome/Chromium was not found. Install Chrome/Chromium or set PUBLISHER_CHROME, then rerun setup.");

  process.stderr.write(`Reddit Agent Publisher setup\n\n`);
  process.stderr.write(`✓ Mode: ${mode}\n`);
  process.stderr.write(`✓ Chrome: ${chromePath}\n`);

  const keyPath = ensureMasterKey(stateDir);
  process.stderr.write(`✓ Secure state: ${stateDir}\n`);
  process.stderr.write(`✓ Encryption key: ${keyPath}\n`);

  const sourceRoot = packageRoot();
  const runtime = options.runtimeInstall === false ? { packageRoot: sourceRoot, stable: false } : installStableRuntime(sourceRoot, stateDir);
  process.stderr.write(runtime.stable ? `✓ Stable runtime installed: ${runtime.packageRoot}\n` : `• Runtime: ${runtime.packageRoot}\n`);
  if (runtime.warning) process.stderr.write(`  Warning: ${runtime.warning}\n`);

  const serverMode = mode === "server";
  const display = process.env.DISPLAY ?? (serverMode ? ":98" : ":0");
  let systemdResult: SystemdInstall = { installed: false, browserManaged: false, serverDesktop: false, vncAvailable: false };
  let cdpUrl: string | undefined;

  if (options.systemd !== false) {
    systemdResult = installSystemd({ runtimeRoot: runtime.packageRoot, stateDir, keyPath, chromePath, display, serverMode });
  }

  if (systemdResult.installed) {
    mergeConfig(stateDir, chromePath, account, display);
    process.stderr.write(`✓ User services installed and publisher daemon started\n`);
  } else if (!serverMode) {
    cdpUrl = startPortableChrome(chromePath, stateDir, account);
    mergeConfig(stateDir, chromePath, account, display, cdpUrl);
    startDetachedDaemon(runtime.packageRoot, stateDir, keyPath);
    process.stderr.write(`✓ Portable local Chrome started at ${cdpUrl}\n`);
    process.stderr.write(`✓ Publisher daemon started in the background\n`);
    if (systemdResult.warning) process.stderr.write(`  systemd not used: ${systemdResult.warning}\n`);
  } else {
    mergeConfig(stateDir, chromePath, account, display);
    startDetachedDaemon(runtime.packageRoot, stateDir, keyPath);
    process.stderr.write(`✓ Publisher daemon started in the background\n`);
    if (systemdResult.warning) process.stderr.write(`  Warning: ${systemdResult.warning}\n`);
  }

  const integrationPaths = writeMcpConfigs(runtime.packageRoot, stateDir);
  process.stderr.write(`✓ MCP configs generated: ${path.dirname(integrationPaths.generic)}\n`);

  const socketPath = path.join(stateDir, "publisher.sock");
  if (await waitForSocket(socketPath)) {
    const canOpenBrowser = !serverMode || systemdResult.serverDesktop;
    if (canOpenBrowser) {
      const auth = await promptForLogin(socketPath, account, interactive);
      if (auth.authenticated) process.stderr.write(`✓ Reddit session authenticated\n`);
      else if (auth.message) process.stderr.write(`• ${auth.message}\n`);
    }
  } else {
    process.stderr.write(`  Warning: publisher daemon socket did not become ready; run reddit-agent-publisher doctor after setup.\n`);
  }

  process.stderr.write(`\nReady.\n`);
  process.stderr.write(`MCP config (${options.client ?? "generic"}): ${integrationPaths[options.client ?? "generic"]}\n`);
  process.stderr.write(`State directory: ${stateDir}\n`);
  if (serverMode) {
    if (systemdResult.vncAvailable) {
      process.stderr.write(`\nFor the one-time Reddit login from your computer:\n  ssh -N -L 5901:127.0.0.1:5901 YOUR_USER@YOUR_SERVER\nThen connect a VNC viewer to localhost:5901. The VNC listener is localhost-only.\n`);
    } else if (!systemdResult.serverDesktop) {
      process.stderr.write(`\nBrowser login still needs a private desktop on this headless server. Install Xvfb + x11vnc (or use your existing private desktop/VNC setup), rerun setup, and keep VNC bound to localhost behind SSH.\n`);
    } else {
      process.stderr.write(`\nA private Xvfb desktop is available, but x11vnc was not detected. Use your existing owner-controlled display access to complete Reddit login.\n`);
    }
  }
}

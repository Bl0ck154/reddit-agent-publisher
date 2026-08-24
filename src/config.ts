import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  stateDir: string;
  socketPath: string;
  chromePath: string;
  display: string;
  approvalTtlSeconds: number;
  mutationCooldownSeconds: number;
  browserIdleSeconds: number;
  redditMetadataCacheSeconds: number;
  actionsHost: string;
  actionsPort: number;
  actionsPublicBaseUrl?: string;
  defaultAccount: string;
  /** Optional portable mode: attach to an already-running local Chrome CDP endpoint instead of managing a systemd browser unit. */
  cdpUrl?: string;
  /** systemd user-unit prefix used by managed browser mode. */
  browserServicePrefix: string;
}

export function loadConfig(): Config {
  const stateDir = process.env.PUBLISHER_STATE_DIR ?? path.join(os.homedir(), ".local/share/reddit-agent-publisher");
  const configPath = process.env.PUBLISHER_CONFIG ?? path.join(stateDir, "config.json");
  let file: Record<string, any> = {};
  if (fs.existsSync(configPath)) file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const cdpUrl = process.env.PUBLISHER_CDP_URL ?? file.cdpUrl;
  return {
    stateDir,
    socketPath: process.env.PUBLISHER_SOCKET ?? file.socketPath ?? path.join(stateDir, "publisher.sock"),
    chromePath: process.env.PUBLISHER_CHROME ?? file.chromePath ?? "/opt/google/chrome/google-chrome",
    display: process.env.DISPLAY ?? file.display ?? ":98",
    approvalTtlSeconds: Number(file.approvalTtlSeconds ?? 900),
    mutationCooldownSeconds: Number(file.mutationCooldownSeconds ?? 15),
    browserIdleSeconds: Number(file.browserIdleSeconds ?? 90),
    redditMetadataCacheSeconds: Number(file.redditMetadataCacheSeconds ?? 900),
    actionsHost: String(process.env.PUBLISHER_ACTIONS_HOST ?? file.actionsHost ?? "127.0.0.1"),
    actionsPort: Number(process.env.PUBLISHER_ACTIONS_PORT ?? file.actionsPort ?? 8791),
    actionsPublicBaseUrl: process.env.PUBLISHER_ACTIONS_PUBLIC_BASE_URL ?? file.actionsPublicBaseUrl,
    defaultAccount: String(process.env.PUBLISHER_DEFAULT_ACCOUNT ?? file.defaultAccount ?? "owner-main"),
    cdpUrl: cdpUrl ? String(cdpUrl) : undefined,
    browserServicePrefix: String(process.env.PUBLISHER_BROWSER_SERVICE_PREFIX ?? file.browserServicePrefix ?? "reddit-agent-publisher-browser"),
  };
}

export function ensureState(config: Config): void {
  for (const dir of [config.stateDir, path.join(config.stateDir, "profiles"), path.join(config.stateDir, "artifacts"), path.join(config.stateDir, "tmp")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  fs.mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o700 });
}

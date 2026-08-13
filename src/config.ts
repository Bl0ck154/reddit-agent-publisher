import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  stateDir: string;
  cdpUrl: string;
  approvalTtlSeconds: number;
  mutationCooldownSeconds: number;
  redditMetadataCacheSeconds: number;
  actionsHost: string;
  actionsPort: number;
  actionsPublicBaseUrl?: string;
  defaultAccount: string;
}

export function loadConfig(): Config {
  const stateDir = process.env.PUBLISHER_STATE_DIR ?? path.join(os.homedir(), ".local/share/reddit-agent-publisher");
  const configPath = process.env.PUBLISHER_CONFIG ?? path.join(stateDir, "config.json");
  let file: Record<string, any> = {};
  if (fs.existsSync(configPath)) file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    stateDir,
    cdpUrl: String(process.env.PUBLISHER_CDP_URL ?? file.cdpUrl ?? "http://127.0.0.1:9222"),
    approvalTtlSeconds: Number(file.approvalTtlSeconds ?? 900),
    mutationCooldownSeconds: Number(file.mutationCooldownSeconds ?? 15),
    redditMetadataCacheSeconds: Number(file.redditMetadataCacheSeconds ?? 900),
    actionsHost: String(process.env.PUBLISHER_ACTIONS_HOST ?? file.actionsHost ?? "127.0.0.1"),
    actionsPort: Number(process.env.PUBLISHER_ACTIONS_PORT ?? file.actionsPort ?? 8791),
    actionsPublicBaseUrl: process.env.PUBLISHER_ACTIONS_PUBLIC_BASE_URL ?? file.actionsPublicBaseUrl,
    defaultAccount: String(file.defaultAccount ?? "default")
  };
}

export function ensureState(config: Config): void {
  for (const dir of [config.stateDir, `${config.stateDir}/artifacts`, `${config.stateDir}/tmp`]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

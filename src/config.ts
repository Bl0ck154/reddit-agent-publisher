import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  stateDir: string;
  cdpUrl: string;
  approvalTtlSeconds: number;
  mutationCooldownSeconds: number;
  redditMetadataCacheSeconds: number;
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
    defaultAccount: String(file.defaultAccount ?? "default")
  };
}

export function ensureState(config: Config): void {
  for (const dir of [config.stateDir, `${config.stateDir}/profiles`, `${config.stateDir}/artifacts`, `${config.stateDir}/tmp`]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

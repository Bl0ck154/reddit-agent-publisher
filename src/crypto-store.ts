import crypto from "node:crypto";
import fs from "node:fs";

function key(): Buffer {
  const p = process.env.PUBLISHER_MASTER_KEY_FILE;
  if (!p || !fs.existsSync(p)) {
    if (process.env.NODE_ENV === "test") return crypto.createHash("sha256").update("test-only-key").digest();
    throw new Error("PUBLISHER_MASTER_KEY_FILE is required");
  }
  const raw = fs.readFileSync(p);
  return raw.length === 32 ? raw : crypto.createHash("sha256").update(raw).digest();
}

export function seal(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64url");
}

export function open<T>(encoded: string): T {
  const raw = Buffer.from(encoded, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
}

export function digest(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

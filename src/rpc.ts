import http from "node:http";
import type { ResultEnvelope } from "./types.js";

export async function rpc(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<ResultEnvelope> {
  const body = JSON.stringify({ method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/rpc", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject); req.end(body);
  });
}

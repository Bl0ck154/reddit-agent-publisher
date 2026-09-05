import crypto from "node:crypto";
import { promises as dns } from "node:dns";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";

const MAX_FILES = 4;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const TIMEOUT_MS = 20_000;

export interface GptActionFileRef {
  name?: string;
  id?: string;
  mime_type?: string;
  download_link?: string;
}


export interface PreparedActionFile {
  path: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
}

export interface PreparedActionImage {
  path: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
}

export class ActionFileError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ActionFileError";
  }
}

function isPublicAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168));
  }
  if (kind === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
    return /^[23][0-9a-f]{3}:/.test(value);
  }
  return false;
}

export function validateGptActionFileUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ActionFileError("GPT_FILE_URL_INVALID", "The ChatGPT image reference is not a valid URL."); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new ActionFileError("GPT_FILE_URL_BLOCKED", "The ChatGPT image URL must use ordinary HTTPS without credentials or a custom port.");
  }
  if (net.isIP(hostname) || (hostname !== "oaiusercontent.com" && !hostname.endsWith(".oaiusercontent.com"))) {
    throw new ActionFileError("GPT_FILE_HOST_BLOCKED", "The image must be attached from the current ChatGPT conversation.");
  }
  return url;
}

export function detectActionImage(buffer: Buffer): { mime_type: string; extension: string } {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { mime_type:"image/png",extension:"png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime_type:"image/jpeg",extension:"jpg" };
  if (buffer.length >= 6 && ["GIF87a","GIF89a"].includes(buffer.subarray(0,6).toString("ascii"))) return { mime_type:"image/gif",extension:"gif" };
  if (buffer.length >= 12 && buffer.subarray(0,4).toString("ascii") === "RIFF" && buffer.subarray(8,12).toString("ascii") === "WEBP") return { mime_type:"image/webp",extension:"webp" };
  throw new ActionFileError("GPT_FILE_NOT_IMAGE", "The attached file is not a supported PNG, JPEG, GIF, or WebP image.", 415);
}

function safeName(value: unknown, index: number, extension: string): string {
  const base = path.basename(String(value || `chatgpt-image-${index + 1}.${extension}`))
    .replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 100);
  return base || `chatgpt-image-${index + 1}.${extension}`;
}

async function requestFile(urlValue: string, redirects = 0, accept = "*/*"): Promise<Buffer> {
  const url = validateGptActionFileUrl(urlValue);
  const addresses = await dns.lookup(url.hostname, { all:true, verbatim:true });
  const selected = addresses.find(entry => isPublicAddress(entry.address));
  if (!selected || addresses.some(entry => !isPublicAddress(entry.address))) {
    throw new ActionFileError("GPT_FILE_DNS_BLOCKED", "The ChatGPT image host did not resolve exclusively to public addresses.");
  }

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    const req = https.request(url, {
      method:"GET",
      headers:{ accept },
      servername:url.hostname,
      lookup:((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null,selected.address,selected.family)) as any,
    }, response => {
      const status = response.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status)) {
        response.resume();
        const location = response.headers.location;
        if (!location || redirects >= MAX_REDIRECTS) { fail(new ActionFileError("GPT_FILE_REDIRECT_BLOCKED", "The ChatGPT image redirect chain is invalid.", 502)); return; }
        void requestFile(new URL(location,url).toString(),redirects + 1,accept).then(resolve,fail);
        return;
      }
      if (status < 200 || status >= 300) { response.resume(); fail(new ActionFileError("GPT_FILE_DOWNLOAD_FAILED", `ChatGPT image download returned HTTP ${status}.`, 502)); return; }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > MAX_FILE_BYTES) { response.resume(); fail(new ActionFileError("GPT_FILE_TOO_LARGE", "The attached image exceeds 20 MiB.", 413)); return; }
      const chunks: Buffer[] = []; let total = 0;
      response.on("data", chunk => {
        const value = Buffer.from(chunk); total += value.length;
        if (total > MAX_FILE_BYTES) { response.destroy(); fail(new ActionFileError("GPT_FILE_TOO_LARGE", "The attached image exceeds 20 MiB.", 413)); return; }
        chunks.push(value);
      });
      response.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
      response.on("error", fail);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new ActionFileError("GPT_FILE_TIMEOUT", "The temporary ChatGPT image link timed out.", 504)));
    req.on("error", error => fail(error instanceof ActionFileError ? error : new ActionFileError("GPT_FILE_DOWNLOAD_FAILED", "The temporary ChatGPT image could not be downloaded.", 502)));
    req.end();
  });
}

async function requestImage(urlValue: string, redirects = 0): Promise<Buffer> {
  return requestFile(urlValue,redirects,"image/png,image/jpeg,image/gif,image/webp");
}

export async function prepareGptActionImages(refs: Array<string | GptActionFileRef>, stateDir: string): Promise<PreparedActionImage[]> {
  if (!refs.length || refs.length > MAX_FILES) throw new ActionFileError("GPT_FILE_COUNT_INVALID", "Attach between one and four images.");
  const outputDir = path.join(stateDir,"artifacts","gpt-files");
  fs.mkdirSync(outputDir,{recursive:true,mode:0o700}); fs.chmodSync(outputDir,0o700);
  const prepared: PreparedActionImage[] = [];
  try {
    for (const [index,ref] of refs.entries()) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref) || !ref.download_link) {
        throw new ActionFileError("GPT_FILE_REFERENCE_UNRESOLVED", "ChatGPT did not provide a downloadable conversation-file reference. Attach the image directly to this GPT chat and retry.");
      }
      const buffer = await requestImage(String(ref.download_link));
      const detected = detectActionImage(buffer);
      const filePath = path.join(outputDir,`${crypto.randomUUID()}.${detected.extension}`);
      fs.writeFileSync(filePath,buffer,{mode:0o600,flag:"wx"});
      prepared.push({ path:filePath,name:safeName(ref.name,index,detected.extension),mime_type:detected.mime_type,size:buffer.length,sha256:`sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}` });
    }
    return prepared;
  } catch (error) {
    for (const item of prepared) fs.rmSync(item.path,{force:true});
    throw error;
  }
}


function safeMime(value: unknown): string {
  const mime=String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

function safeGenericName(value: unknown, index: number): string {
  const base=path.basename(String(value || `chatgpt-file-${index+1}.bin`)).replace(/[^A-Za-z0-9._ -]+/g,"_").slice(0,120);
  return base || `chatgpt-file-${index+1}.bin`;
}

export async function prepareGptActionFiles(refs: Array<string | GptActionFileRef>, stateDir: string, maxFiles = 1): Promise<PreparedActionFile[]> {
  if (!refs.length || refs.length > maxFiles) throw new ActionFileError("GPT_FILE_COUNT_INVALID", `Attach between one and ${maxFiles} file${maxFiles===1?"":"s"}.`);
  const outputDir=path.join(stateDir,"artifacts","gpt-files");
  fs.mkdirSync(outputDir,{recursive:true,mode:0o700}); fs.chmodSync(outputDir,0o700);
  const prepared:PreparedActionFile[]=[];
  try {
    for (const [index,ref] of refs.entries()) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref) || !ref.download_link) throw new ActionFileError("GPT_FILE_REFERENCE_UNRESOLVED","ChatGPT did not provide a downloadable conversation-file reference. Attach the file directly to this GPT chat and retry.");
      const buffer=await requestFile(String(ref.download_link));
      if (buffer.length<1 || buffer.length>MAX_FILE_BYTES) throw new ActionFileError("GPT_FILE_TOO_LARGE","The attached file exceeds 20 MiB.",413);
      const name=safeGenericName(ref.name,index);
      const ext=(path.extname(name).replace(/[^A-Za-z0-9.]/g,"").slice(0,12) || ".bin");
      const filePath=path.join(outputDir,`${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(filePath,buffer,{mode:0o600,flag:"wx"});
      prepared.push({path:filePath,name,mime_type:safeMime(ref.mime_type),size:buffer.length,sha256:`sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`});
    }
    return prepared;
  } catch (error) {
    for (const item of prepared) fs.rmSync(item.path,{force:true});
    throw error;
  }
}

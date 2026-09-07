import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMcpConfigs, ensureMasterKey, renderSystemdUnits, resolveSetupMode, sanitizeAccountId } from "../setup.js";

test("setup account ids are made safe for profiles and systemd instances", () => {
  assert.equal(sanitizeAccountId("owner-main"), "owner-main");
  assert.equal(sanitizeAccountId("My Reddit / Main"), "My_Reddit___Main");
  assert.throws(() => sanitizeAccountId("   "));
});

test("automatic setup mode distinguishes desktop from headless server", () => {
  assert.equal(resolveSetupMode("auto", { DISPLAY: ":0" }, "linux"), "desktop");
  assert.equal(resolveSetupMode("auto", {}, "linux"), "server");
  assert.equal(resolveSetupMode("auto", {}, "darwin"), "desktop");
  assert.equal(resolveSetupMode("server", { DISPLAY: ":0" }, "linux"), "server");
});

test("setup creates one persistent 32-byte master key and never rotates it on rerun", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-setup-key-"));
  try {
    const firstPath = ensureMasterKey(root);
    const first = fs.readFileSync(firstPath);
    const secondPath = ensureMasterKey(root);
    const second = fs.readFileSync(secondPath);
    assert.equal(first.length, 32);
    assert.equal(firstPath, secondPath);
    assert.deepEqual(first, second);
    if (process.platform !== "win32") assert.equal(fs.statSync(firstPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated systemd services keep VNC local-only and bind daemon to setup state", () => {
  const units = renderSystemdUnits({
    runtimeRoot: "/home/test/.local/share/reddit-agent-publisher/runtime/node_modules/reddit-agent-publisher",
    stateDir: "/home/test/.local/share/reddit-agent-publisher",
    keyPath: "/home/test/.local/share/reddit-agent-publisher/master.key",
    chromePath: "/usr/bin/google-chrome",
    display: ":98",
    serverMode: true,
    xvfbPath: "/usr/bin/Xvfb",
    x11vncPath: "/usr/bin/x11vnc",
  });
  assert.match(units["reddit-agent-publisher.service"], /PUBLISHER_MASTER_KEY_FILE/);
  assert.match(units["reddit-agent-publisher-browser@.service"], /DISPLAY=:98/);
  assert.match(units["reddit-agent-publisher-vnc.service"], /-localhost/);
  assert.match(units["reddit-agent-publisher-vnc.service"], /-rfbport 5901/);
  assert.match(units["reddit-agent-publisher-xvfb.service"], /-nolisten tcp/);
});

test("MCP config generators point clients at the stable local stdio process", () => {
  const configs = buildMcpConfigs("/runtime/reddit-agent-publisher", "/state/reddit-agent-publisher");
  assert.match(configs.codex, /mcp_servers\.reddit-agent-publisher/);
  assert.match(configs.codex, /\/runtime\/reddit-agent-publisher\/dist\/mcp\.js/);
  const generic = JSON.parse(configs.generic);
  assert.equal(generic.mcpServers["reddit-agent-publisher"].args[0], "/runtime/reddit-agent-publisher/dist/mcp.js");
  assert.equal(generic.mcpServers["reddit-agent-publisher"].env.PUBLISHER_STATE_DIR, "/state/reddit-agent-publisher");
});

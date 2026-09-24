// End-to-end smoke test: runs the built server over stdio, as Claude Code does, in relay mode,
// and drives whatever games it finds through the same tools the model gets.
//
//   npm run build
//   node scripts/smoke.mjs [--wait 60] [--out ./smoke-out] [--listen 9010]
//
// Then open a browser game with ?devbridge=ws://127.0.0.1:9010 (the script waits for it), and/or
// have a HashLink game running on 9001-9010 (found by list_instances). Every game found gets:
// list_screens, list_interactives, click_button, set_parameter (+ get_parameters), screenshot
// (saved under --out), get_traces, and the events tool. Exit status 1 when a step fails.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const waitSeconds = Number(arg("--wait", "60"));
const outDir = arg("--out", "smoke-out");
const listen = arg("--listen", "9010");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/index.js", import.meta.url)), `--listen=${listen}`],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

let failures = 0;
const log = (msg) => console.log(msg);

async function tool(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // a caption, e.g. the screenshot's
  }
  return { isError: res.isError === true, body, content: res.content };
}

async function step(label, fn) {
  try {
    const detail = await fn();
    log(`  ok   ${label}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    failures++;
    log(`  FAIL ${label}: ${error.message}`);
  }
}

function expectOk(res, what) {
  if (res.isError) throw new Error(`${what} -> ${JSON.stringify(res.body)}`);
  return res.body;
}

const { tools } = await client.listTools();
const { version } = client.getServerVersion();
log(`server ${version}, ${tools.length} tools; relay on ws://127.0.0.1:${listen}`);

// Wait for a browser game to dial in (or give up and use what list_instances finds).
const deadline = Date.now() + waitSeconds * 1000;
let listing;
let waitingLogged = false;
for (;;) {
  listing = expectOk(await tool("list_instances", { scan: true }), "list_instances");
  if (listing.instances.some((i) => i.kind === "browser") || Date.now() > deadline) break;
  if (!waitingLogged) {
    log(`waiting up to ${waitSeconds}s for a browser game: open it with ${listing.relay?.openPageWith}`);
    waitingLogged = true;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
const targets = [
  ...listing.instances.map((i) => ({ id: i.id, kind: i.kind, label: i.title ?? i.app ?? i.id })),
  ...listing.discovered.filter((d) => !d.error).map((d) => ({ id: d.id, kind: d.kind, label: `HashLink :${d.port}` })),
];
log(`games: ${targets.map((t) => `${t.id} (${t.kind}, ${t.label})`).join(", ") || "none"}`);
if (targets.length === 0) {
  log("FAIL no game found");
  await client.close();
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  log(`\n${target.id} — ${target.label}`);
  const t = { target: target.id };

  await step("list_screens", async () => {
    const r = expectOk(await tool("list_screens", t), "list_screens");
    return r.screens.filter((s) => s.active).map((s) => s.name).join(", ") + " active";
  });

  await step("list_interactives + click_button", async () => {
    const r = expectOk(await tool("list_interactives", t), "list_interactives");
    const clickable = r.interactives.find((i) => !i.disabled && i.id && !/back|quit|exit|close/i.test(i.id));
    if (!clickable) return "no enabled interactive on this screen (click skipped)";
    const click = expectOk(await tool("click_button", { ...t, id: clickable.id }), "click_button");
    return `${r.interactives.length} interactives; clicked "${clickable.id}" on ${click.screen}`;
  });

  await step("set_parameter + get_parameters", async () => {
    const live = expectOk(await tool("list_active_programmables", t), "list_active_programmables").programmables;
    const enumOf = (p) => (p.parameterDefinitions ?? []).find((d) => d.type?.type === "enum" && d.type.values.length > 1);
    const target2 = live.find((p) => enumOf(p));
    if (!target2) return "no live programmable with an enum parameter (skipped)";
    const def = enumOf(target2);
    const first = live.find((p) => p.name === target2.name);
    const current = String(first.currentParameters?.[def.name] ?? def.type.values[0]);
    const next = def.type.values.find((v) => v !== current);
    expectOk(await tool("set_parameter", { ...t, programmable: target2.name, param: def.name, value: next }), "set_parameter");
    const after = expectOk(await tool("get_parameters", { ...t, programmable: target2.name }), "get_parameters");
    expectOk(await tool("set_parameter", { ...t, programmable: target2.name, param: def.name, value: current }), "set_parameter back");
    const seen = after.parameters.find((p) => p.name === def.name)?.currentValue;
    if (String(seen) !== next) throw new Error(`${target2.name}.${def.name} reads ${seen}, expected ${next}`);
    return `${target2.name}.${def.name}: ${current} -> ${next} -> ${current}`;
  });

  await step("screenshot", async () => {
    const r = await tool("screenshot", { ...t, width: 640 });
    if (r.isError) throw new Error(JSON.stringify(r.body));
    const image = r.content.find((c) => c.type === "image");
    const png = Buffer.from(image.data, "base64");
    if (png.toString("latin1", 1, 4) !== "PNG") throw new Error("not a PNG");
    const file = join(outDir, `${target.id.replace(/[^a-z0-9-]/gi, "_")}.png`);
    writeFileSync(file, png);
    return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)} -> ${file} (${r.content.find((c) => c.type === "text")?.text})`;
  });

  await step("get_traces", async () => {
    const r = expectOk(await tool("get_traces", { ...t, limit: 3 }), "get_traces");
    return `${r.total} buffered; last: ${r.lines.at(-1)?.slice(-80)}`;
  });
}

await step("events", async () => {
  await new Promise((r) => setTimeout(r, 500));
  const r = expectOk(await tool("events", { limit: 1000 }), "events");
  const byInstance = {};
  for (const e of r.events) byInstance[`${e.instance}/${e.kind}`] = (byInstance[`${e.instance}/${e.kind}`] ?? 0) + 1;
  return `${r.events.length} events, lastId ${r.lastId}: ${JSON.stringify(byInstance)}`;
});

await step("no target with several games", async () => {
  const r = await tool("ping");
  if (targets.length > 1 && r.body.code !== "ambiguous_target") throw new Error(JSON.stringify(r.body));
  return targets.length > 1 ? r.body.code : "one game: answered without target";
});

await client.close();
log(failures === 0 ? "\nsmoke: all steps passed" : `\nsmoke: ${failures} step(s) failed`);
process.exit(failures === 0 ? 0 : 1);

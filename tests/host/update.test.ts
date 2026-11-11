// What an update needs from the host (protocol.md "v3.5: updates"): it says
// which build it runs (the welcome, the registry, `herdr-chat-host build`, the
// same three), and a restart's shutdown ends the process even when a client
// keeps its socket open (the chat then starts the new host).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { startHost, idle, sleep, HOST_ENTRY, HOST_NODE } from "./harness.ts";

test("the build: the welcome, the registry and `herdr-chat-host build` agree", async () => {
  const h = await startHost({ name: "update-build" });
  try {
    await h.client.waitFor(idle, 10_000);
    const cli = JSON.parse(execFileSync(HOST_NODE, [HOST_ENTRY, "build"], { encoding: "utf8" }));
    assert.match(cli.build, /^[0-9a-f]{12}$/);
    assert.match(cli.version, /^\d+\.\d+\.\d+$/);
    const welcome = h.client.records.find((r) => r.t === "welcome");
    assert.equal(welcome.host.build, cli.build);
    assert.equal(welcome.host.version, cli.version);
    assert.equal(h.registry?.build, cli.build);
    assert.equal(h.registry?.version, cli.version);
    h.artifact("update-build", { cli });
  } finally {
    await h.stop();
  }
});

test("shutdown ends the host even when a client never closes its side", async () => {
  const h = await startHost({ name: "update-shutdown" });
  try {
    await h.client.waitFor(idle, 10_000);
    // A client that keeps its half of the socket open after the host's FIN.
    const reg = h.registry!;
    const raw = net.connect({ port: reg.port!, host: "127.0.0.1", allowHalfOpen: true });
    await new Promise<void>((r) => raw.once("connect", () => r()));
    raw.write(JSON.stringify({ t: "hello", v: 1, token: reg.token, client: "test" }) + "\n");
    raw.on("data", () => {});
    raw.on("end", () => {}); // and never end() back
    await sleep(300);
    const t0 = Date.now();
    await h.client.req("shutdown").catch(() => {});
    const code = await Promise.race([h.exited, sleep(5000).then(() => "still running")]);
    assert.notEqual(code, "still running", "the host exited");
    assert.ok(Date.now() - t0 < 3000, `exited in ${Date.now() - t0} ms`);
    assert.equal(h.registry?.pid, null);
    raw.destroy();
    h.artifact("update-shutdown", { exitedMs: Date.now() - t0 });
  } finally {
    await h.stop();
  }
});

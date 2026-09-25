/**
 * personalctl.test.mjs — 业务确定性工具测试。
 * 覆盖：artifact check（引用/小节/哈希/失败退出）、run record 账本、
 *       report render 发布包 manifest。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CTL = join(__dirname, "../../tools/personalctl/bin/personalctl.mjs");

function runCli(args, { cwd, env = {} } = {}) {
  const parse = (s) => {
    try { return JSON.parse(s); } catch { return s; }
  };
  try {
    const stdout = execFileSync(process.execPath, [CTL, ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { code: 0, stdout: parse(stdout) };
  } catch (err) {
    return { code: err.status, stdout: parse(err.stdout ?? ""), stderr: err.stderr };
  }
}

test("artifact check：引用与小节齐全 → ok，带 sha256", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "coagent-ctl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, "artifact.md");
  const body = `snapshot_id: snap_x1

## 已确认决定
- 采用 PGM [M:mem_1@2]

## 助手建议
- 先跑通 context-pack

## 未决问题
- 有道自动导入？[E:ev_a1]
`;
  writeFileSync(f, body);
  const r = runCli(["artifact", "check", f]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.ok, true);
  assert.equal(r.stdout.snapshot_id, "snap_x1");
  assert.deepEqual(r.stdout.evidence_refs, ["ev_a1"]);
  assert.deepEqual(r.stdout.memory_refs, [{ id: "mem_1", version: 2 }]);
  assert.equal(
    r.stdout.sha256,
    createHash("sha256").update(body).digest("hex"),
  );
});

test("artifact check：缺小节/记忆引用缺版本 → 失败退出码 6", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "coagent-ctl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, "bad.md");
  writeFileSync(f, "- 采用 [M:mem_9]"); // 无小节、无 @版本
  const r = runCli(["artifact", "check", f]);
  assert.equal(r.code, 6);
  assert.equal(r.stdout.ok, false);
  assert.ok(r.stdout.errors.some((e) => e.includes("mem_9")));
  assert.ok(r.stdout.errors.some((e) => e.includes("缺少必填小节")));
});

test("run record：追加账本（不清空历史），记录 snapshot 与模型路由", (t) => {
  const ws = mkdtempSync(join(tmpdir(), "coagent-ws-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const f = join(ws, "out.md");
  writeFileSync(f, "hello");

  const a = runCli(["run", "record", "--stage", "context-pack", "--file", f,
    "--snapshot", "snap_1", "--destination", "mtplx", "--model", "mtplx-flash-next-optimized-speed"],
    { cwd: ws });
  assert.equal(a.code, 0);

  const b = runCli(["run", "record", "--stage", "review", "--file", f,
    "--snapshot", "snap_2"], { cwd: ws });
  assert.equal(b.code, 0);

  const lines = readFileSync(join(ws, "runs", "runs.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "账本只增不清");
  const first = JSON.parse(lines[0]);
  assert.equal(first.stage, "context-pack");
  assert.equal(first.context_snapshot_id, "snap_1");
  assert.equal(first.model_route.destination, "mtplx");
  assert.equal(first.model_route.model, "mtplx-flash-next-optimized-speed");
  const rec = JSON.parse(lines[1]);
  assert.equal(rec.context_snapshot_id, "snap_2");
  assert.ok(rec.run_id.startsWith("run_"));
  assert.equal(rec.artifact.sha256, createHash("sha256").update("hello").digest("hex"));
});

test("report render：副本 + manifest 哈希一致", (t) => {
  const ws = mkdtempSync(join(tmpdir(), "coagent-ws-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const f = join(ws, "report.md");
  writeFileSync(f, "# 报告\n\n正文");
  const r = runCli(["report", "render", f, "--out", join(ws, "outputs", "release")], { cwd: ws });
  assert.equal(r.code, 0);
  const { dest, manifestPath } = r.stdout;
  assert.ok(existsSync(dest));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(
    manifest.sha256,
    createHash("sha256").update(readFileSync(dest)).digest("hex"),
  );
  assert.equal(manifest.schema_version, "coagent.release.v1");
});

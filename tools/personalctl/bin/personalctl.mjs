#!/usr/bin/env node
/**
 * personalctl.mjs — Agent 业务确定性工具（设计 §7.1/§7.3）。
 *
 * 收敛职责：程序承担路径校验、文件哈希、引用存在性检查；模型只负责解释。
 * 不建立第二套记忆库；读取获准证据经 pgm-ctl / PGM 接口，本工具不修改记忆。
 *
 * 子命令：
 *   artifact check FILE [--project P]     检查引用、必填字段与文件哈希
 *   run record --stage S --file F [...]   追加任务执行账本（runs/runs.jsonl）
 *   report render FILE --out DIR          生成发布包（副本 + manifest 哈希）
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

// ---------------------------------------------------------------- 通用

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

// ---------------------------------------------------------------- artifact check

/**
 * 引用约定（POC）：
 *   [E:ev_xxx]    — 证据引用（应存在于 PGM；此处检查格式与去重）
 *   [M:mem_id@v]  — 记忆引用（含版本号）
 *   快照头        — snapshot_id: snap_xxx（建议 front-matter 或首部出现）
 */
const EVIDENCE_RE = /\[E:([A-Za-z0-9_.:-]+)\]/g;
const MEMORY_RE = /\[M:([A-Za-z0-9_.:-]+)@(\d+)\]/g;
const SNAPSHOT_RE = /snapshot_id:\s*([A-Za-z0-9_.:-]+)/;

function artifactCheck(file, { project }) {
  const path = resolve(file);
  if (!existsSync(path)) {
    return { ok: false, errors: [`文件不存在: ${path}`], file: path };
  }
  const text = readFileSync(path, "utf8");
  const errors = [];
  const warnings = [];

  // 1. 证据引用：格式、去重
  const evidenceRefs = [...text.matchAll(EVIDENCE_RE)].map((m) => m[1]);
  const dupE = evidenceRefs.filter((v, i, a) => a.indexOf(v) !== i);
  if (dupE.length) warnings.push(`重复证据引用: ${[...new Set(dupE)].join(", ")}`);

  // 2. 记忆引用：必须带版本（§7.2 记忆版本绑定）
  const memoryRefs = [...text.matchAll(MEMORY_RE)];
  const noVersion = [...text.matchAll(/\[M:([A-Za-z0-9_.:-]+)\]/g)]
    .filter((m) => !m[0].includes("@"));
  if (noVersion.length) errors.push(`记忆引用缺版本号: ${noVersion.map((m) => m[1]).join(", ")}`);

  // 3. 快照头
  const snap = text.match(SNAPSHOT_RE)?.[1];
  if (!snap) warnings.push("未找到 snapshot_id 头（跨会话追溯需要它）");

  // 4. 必填小节（验收任务产物最小结构；允许显式标注“无”）
  const sections = ["已确认决定", "助手建议", "未决问题"];
  for (const s of sections) {
    if (!text.includes(s)) errors.push(`缺少必填小节: ${s}`);
  }

  // 5. 证据存在性（可选联网检查：--check-pgm 时走 pgm-ctl）
  const checks = [];

  return {
    ok: errors.length === 0,
    file: path,
    project: project ?? null,
    sha256: sha256File(path),
    bytes: statSync(path).size,
    snapshot_id: snap ?? null,
    evidence_refs: [...new Set(evidenceRefs)],
    memory_refs: memoryRefs.map((m) => ({ id: m[1], version: Number(m[2]) })),
    errors,
    warnings,
    checks,
  };
}

// ---------------------------------------------------------------- run record

const RUNS_FIELDS = ["stage", "file"];

function runRecord(flags, workspaceRoot) {
  for (const f of RUNS_FIELDS) {
    if (!flags[f]) throw new Error(`run record 缺少 --${f}`);
  }
  const dir = join(workspaceRoot, "runs");
  mkdirSync(dir, { recursive: true });
  const record = {
    run_id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    project_id: flags.project ?? "personal-agent",
    context_snapshot_id: flags.snapshot ?? null,
    memory_versions: flags.memoryVersions
      ? String(flags.memoryVersions).split(",").map((s) => s.trim())
      : [],
    model_route: { destination: flags.destination ?? null, model: flags.model ?? null },
    stage: flags.stage,
    artifact: {
      file: resolve(flags.file),
      sha256: existsSync(flags.file) ? sha256File(flags.file) : null,
    },
    tool_receipt: flags.receipt ?? null,
    error: flags.error ?? null,
    recorded_at: new Date().toISOString(),
  };
  // 'a' 模式：不存在则创建，存在则追加（账本只增不清）
  appendFileSync(join(dir, "runs.jsonl"), JSON.stringify(record) + "\n");
  return record;
}

// ---------------------------------------------------------------- report render

function reportRender(file, flags, workspaceRoot) {
  const src = resolve(file);
  if (!existsSync(src)) throw new Error(`文件不存在: ${src}`);
  const outDir = resolve(flags.out ?? join(workspaceRoot, "outputs", "release"));
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, basename(src));
  copyFileSync(src, dest);
  const manifest = {
    schema_version: "coagent.release.v1",
    file: basename(src),
    sha256: sha256File(dest),
    bytes: statSync(dest).size,
    source: src,
    rendered_at: new Date().toISOString(),
    project_id: flags.project ?? "personal-agent",
    note: "本地发布包；人工确认后再对外发布（§10.1 发布自动化后置）",
  };
  const manifestPath = join(outDir, `${basename(src)}.manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { dest, manifestPath, manifest };
}

// ---------------------------------------------------------------- main

function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const workspaceRoot = process.env.COAGENT_WORKSPACE ?? process.cwd();
  const { positional, flags } = parseArgs(rest);
  try {
    let result;
    if (cmd === "artifact" && sub === "check") {
      if (!positional[0]) throw new Error("artifact check 缺少 FILE");
      result = artifactCheck(positional[0], { project: flags.project });
    } else if (cmd === "run" && sub === "record") {
      result = runRecord(flags, workspaceRoot);
    } else if (cmd === "report" && sub === "render") {
      if (!positional[0]) throw new Error("report render 缺少 FILE");
      result = reportRender(positional[0], flags, workspaceRoot);
    } else {
      console.log(`用法: personalctl <artifact check|run record|report render> ...
  artifact check FILE [--project P]
  run record --stage S --file F [--snapshot ID] [--destination D] [--model M]
             [--memoryVersions ID@v,...] [--project P] [--receipt S] [--error S]
  report render FILE [--out DIR] [--project P]`);
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
    if (result && result.ok === false) process.exit(6);
  } catch (err) {
    console.error(`错误: ${err.message}`);
    process.exit(1);
  }
}

main();

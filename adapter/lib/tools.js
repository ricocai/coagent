/**
 * tools.js — 适配器共享工具实现（MCP server 与 pgm-ctl CLI 共用）。
 *
 * 工具名沿用设计 §8.1 约定：memory.search / memory.build_context /
 * memory.get_evidence / memory.propose，外加 outbox 三个运维入口。
 * 这些是本项目自定义工具名，不是 Harness 官方内置能力（§8.1）。
 */

import { readFileSync } from "node:fs";
import { PgmClient, PgmApiError, ProtocolError, LocalOnlyLeakError } from "./pgm-client.js";
import { Outbox, makeEvent, InjectedContextError } from "./outbox.js";

export { PgmClient, PgmApiError, ProtocolError, LocalOnlyLeakError, Outbox, makeEvent };

/** 适配器配置：env 优先，缺省值仅用于本地回环联调。 */
export function configFromEnv(env = process.env) {
  const cfg = {
    baseUrl: env.PGM_BASE_URL ?? "http://127.0.0.1:8787",
    // dsh 拉起 MCP 子进程会擦洗 /TOKEN/i 变量，因此 dsh patch 用 PGM_HARNESS_TOKEN
    // 显式注入为 PGM_TOKEN；CLI 直跑时允许直接读系统变量 PGM_HARNESS_TOKEN。
    token: env.PGM_TOKEN ?? env.PGM_HARNESS_TOKEN,
    projectId: env.PGM_PROJECT ?? "personal-agent",
    destination: env.PGM_DESTINATION ?? "local",
    sessionId: env.PGM_SESSION ?? "default",
    outboxPath:
      env.PGM_OUTBOX_PATH ?? `${env.HOME ?? "."}/c-doing/c-agent/state/dsh/pgm-outbox.jsonl`,
  };
  if (!cfg.token) {
    throw new Error(
      "缺少 PGM_TOKEN 环境变量（由 `pgm token issue --client-id ...` 签发；" +
        "只经环境变量传递，不写入代码/日志）",
    );
  }
  return cfg;
}

export function createClient(cfg) {
  return new PgmClient({
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    projectId: cfg.projectId,
    destination: cfg.destination,
    sessionId: cfg.sessionId,
  });
}

export function createOutbox(cfg) {
  return new Outbox({ path: cfg.outboxPath });
}

// ---------------------------------------------------------------- 工具定义

/** MCP tools/list 用的声明（JSON Schema，输入参数校验由实现层做）。 */
export function toolDefinitions() {
  return [
    {
      name: "memory.search",
      description:
        "在授权项目范围内检索 Global Memory 的来源与记忆。只读。返回记忆 id、版本、状态与来源定位。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词（服务端做字面量转义）" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        required: ["query"],
      },
    },
    {
      name: "memory.build_context",
      description:
        "构建当前任务的授权上下文包（pgm.context.v1）。返回 snapshot_id、版本、记忆正文与 excluded_summary。" +
        "目的地路由由适配器启动配置绑定，不可指定。",
      inputSchema: {
        type: "object",
        properties: {
          purpose: { type: "string", description: "任务用途（进入审计）" },
          query: { type: "string", description: "任务相关的可选检索词" },
          budget_max_tokens: { type: "integer", default: 4000 },
          ttl_minutes: { type: "integer", default: 15 },
        },
      },
    },
    {
      name: "memory.get_evidence",
      description: "按需读取获准证据片段（服务端每次重新鉴权；超长截断）。只读。",
      inputSchema: {
        type: "object",
        properties: { event_id: { type: "string" } },
        required: ["event_id"],
      },
    },
    {
      name: "memory.propose",
      description:
        "提交长期记忆候选。只写候选（candidate），无审批权；用户须在 PGM 管理入口确认。" +
        "助手建议不得伪装成用户已确认决定（role 测试）。",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["decision", "fact", "preference", "procedure", "episode", "project_state", "todo"],
          },
          content: { type: "string", minLength: 1 },
          scope: { type: "string", default: "global", description: "global 或 project:<id>" },
          classification: { type: "string", enum: ["public", "personal", "local_only"], default: "personal" },
          evidence_ids: { type: "array", items: { type: "string" }, default: [] },
        },
        required: ["type", "content"],
      },
    },
    {
      name: "memory.events_queue",
      description:
        "将本轮已完结（settled）的原生交互排队等待回流 PGM。同键事件幂等跳过；" +
        "injected_context 来源被拒绝（防回流污染）。这只是待发送队列，不是长期记忆。",
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
          text: { type: "string", minLength: 1 },
          message_id: { type: "string", description: "客户端生成的稳定消息 ID（幂等键）" },
          conversation_id: { type: "string" },
          occurred_at: { type: "string", description: "ISO 8601；缺省取当前时间" },
        },
        required: ["role", "text", "message_id"],
      },
    },
    {
      name: "memory.events_flush",
      description: "重放 outbox 中 pending 事件到 PGM（幂等）。用于恢复同步。",
      inputSchema: {
        type: "object",
        properties: { batch_size: { type: "integer", default: 20 } },
      },
    },
    {
      name: "memory.events_status",
      description: "查看事件回流通路健康状态：PGM 就绪 + outbox 积压。",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

// ---------------------------------------------------------------- 工具实现

function json(v) {
  return JSON.stringify(v, null, 2);
}

/**
 * 统一调度：name → result string。
 * 错误处理约定（§8.3）：PGM 不可用/失效明确报错，不假装成功。
 */
export async function dispatchTool(client, outbox, name, args = {}) {
  switch (name) {
    case "memory.search": {
      const result = await client.search({
        query: String(args.query ?? ""),
        limit: args.limit ?? 20,
      });
      return json(result);
    }
    case "memory.build_context": {
      const snap = await client.buildContext({
        purpose: args.purpose,
        query: args.query,
        budgetMaxTokens: args.budget_max_tokens ?? 4000,
        ttlMinutes: args.ttl_minutes ?? 15,
      });
      return json({
        snapshot_id: snap.snapshot_id,
        status: snap.status,
        destination: snap.destination,
        policy_revision: snap.policy_revision,
        scope_revisions: snap.scope_revisions,
        created_at: snap.created_at,
        expires_at: snap.expires_at,
        memory_refs: snap.memory_refs,
        open_questions: snap.open_questions,
        excluded_summary: snap.excluded_summary,
        memories: snap.memories,
      });
    }
    case "memory.get_evidence": {
      if (!args.event_id) throw new Error("缺少 event_id");
      return json(await client.getEvidence(String(args.event_id)));
    }
    case "memory.propose": {
      const result = await client.propose({
        type: args.type,
        content: String(args.content ?? ""),
        scope: args.scope ?? "global",
        classification: args.classification ?? "personal",
        evidenceIds: args.evidence_ids ?? [],
      });
      return json({
        ...result,
        note: "候选已提交，等待用户在 PGM 管理入口确认；本工具无审批权。",
      });
    }
    case "memory.events_queue": {
      const event = makeEvent({
        projectId: client.projectId,
        role: args.role,
        text: String(args.text ?? ""),
        messageId: String(args.message_id),
        conversationId: args.conversation_id,
        occurredAt: args.occurred_at,
      });
      const { queued, eventKey } = outbox.append(event);
      return json({ queued, event_key: eventKey, outbox: outbox.stats() });
    }
    case "memory.events_flush": {
      return json(await outbox.flush(client, { batchSize: args.batch_size ?? 20 }));
    }
    case "memory.events_status": {
      let pgm = "unreachable";
      try {
        await client.ready();
        pgm = "ready";
      } catch (err) {
        pgm = `unreachable (${err.message})`;
      }
      return json({ pgm, outbox: outbox.stats() });
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

/** 从 JSONL 文件批量入队（pgm-ctl events:queue --file）。 */
export function queueEventsFromJsonl(outbox, path) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const queued = [];
  const skipped = [];
  for (const line of lines) {
    const raw = JSON.parse(line);
    // 允许文件里是完整 pgm.event.v1，或 makeEvent 的简化字段
    const event = raw.schema_version === "pgm.event.v1" ? raw : null;
    try {
      if (event) {
        const r = outbox.append(event);
        (r.queued ? queued : skipped).push(r.eventKey);
      } else {
        const ev = makeEvent({
          projectId: raw.project_id,
          role: raw.role,
          text: raw.text,
          messageId: raw.message_id,
          conversationId: raw.conversation_id,
          occurredAt: raw.occurred_at,
          origin: raw.origin ?? "native",
        });
        const r = outbox.append(ev);
        (r.queued ? queued : skipped).push(r.eventKey);
      }
    } catch (err) {
      if (err instanceof InjectedContextError) skipped.push(`${err.message}`);
      else throw err;
    }
  }
  return { queued, skipped, outbox: outbox.stats() };
}

/** 错误 → 进程退出码（CLI 用）。 */
export function exitCodeFor(err) {
  if (err instanceof PgmApiError) {
    if (err.httpStatus === 503) return 2; // PGM 不可用
    if (err.httpStatus === 401 || err.httpStatus === 403) return 3; // 凭据/权限
    if (err.httpStatus === 409) return 4; // 快照失效/版本冲突
    return 5;
  }
  if (err instanceof ProtocolError) return 6;
  if (err instanceof LocalOnlyLeakError) return 7;
  return 1;
}

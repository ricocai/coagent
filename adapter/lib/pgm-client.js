/**
 * pgm-client.js — PGM (Global Memory) 受限客户端核心库。
 *
 * 设计依据：deepseek_harness_personal_agent_poc.md §3.3 / §8.1 / §8.1.1
 * 契约对齐：global-mem/apps/memoryd/pgm/{schemas,auth,service}.py
 *
 * 边界（设计 §2/§8）：
 *  - 只读 + 只写候选 + 事件回流；不具备任何审批权（decide 是管理身份操作，本库不封装）。
 *  - destination 由适配器启动配置绑定（来自真实模型供应商路由），
 *    工具调用方不能随意声明目的地（§4.3）。
 *  - validate 采 singleflight：仅合并并发在途的相同只读校验；
 *    已完成的 valid 结果不缓存（completed_validation_cache_ttl_ms = 0，§8.1.1）。
 *  - local_only / secret_excluded 深度防御：destination 非本地时，
 *    即使服务端已过滤，客户端仍复核快照正文（§11.7）。
 */

/** PGM 协议契约版本（对应 global-mem packages/contracts/pgm.context.v1.json）。 */
export const CONTEXT_SCHEMA = "pgm.context.v1";
export const EVENT_SCHEMA = "pgm.event.v1";

/** 允许绑定的目的地路由。cloud:* 的快照会做 local_only 深度复核。 */
export const DESTINATIONS = {
  MTPLX: "mtplx",
  OMLX: "omlx",
  LMSTUDIO: "lmstudio",
  LOCAL: "local",
  KIMI: "cloud:kimi",
};

export function isCloudDestination(destination) {
  return typeof destination === "string" && destination.startsWith("cloud:");
}

/** PGM 服务端错误 → 结构化异常（错误体形如 {error:{code,message}}）。 */
export class PgmApiError extends Error {
  constructor(code, message, httpStatus, detail) {
    super(`PGM ${code} (${httpStatus}): ${message}`);
    this.name = "PgmApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export class ProtocolError extends Error {
  constructor(message) {
    super(`PGM 协议不兼容: ${message}`);
    this.name = "ProtocolError";
  }
}

/** local_only 泄漏深度防御（§11.7：不允许 local_only 进入云端链路）。 */
export class LocalOnlyLeakError extends Error {
  constructor(memoryIds) {
    super(
      `local_only/secret_excluded 记忆出现在云端目的地快照中: ${memoryIds.join(", ")}`,
    );
    this.name = "LocalOnlyLeakError";
    this.memoryIds = memoryIds;
  }
}

const RETRYABLE = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * PGM 受限客户端。
 * @param {object} opts
 * @param {string} opts.baseUrl        如 http://127.0.0.1:8787
 * @param {string} opts.token          Bearer 应用令牌（pgm token issue 签发）
 * @param {string} opts.projectId      授权项目，如 personal-agent
 * @param {string} opts.destination    真实模型路由目的地（启动时绑定）
 * @param {string} [opts.sessionId]    singleflight 会话键的一部分
 * @param {number} [opts.timeoutMs]    请求超时，默认 10s
 * @param {typeof fetch} [opts.fetchImpl] 可注入 fetch（测试用）
 */
export class PgmClient {
  constructor({
    baseUrl,
    token,
    projectId,
    destination,
    sessionId = "default",
    timeoutMs = 10_000,
    fetchImpl = fetch,
  }) {
    if (!baseUrl) throw new Error("PgmClient: baseUrl 必填");
    if (!token) throw new Error("PgmClient: token 必填（勿写进代码，用环境变量）");
    if (!projectId) throw new Error("PgmClient: projectId 必填");
    if (!destination) throw new Error("PgmClient: destination 必填（真实模型路由）");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.projectId = projectId;
    this.destination = destination;
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    /** @type {Map<string, Promise<object>>} singleflight 在途校验 */
    this._inflightValidates = new Map();
  }

  // ------------------------------------------------------------ 底层请求

  async _request(method, path, { body, headers = {}, auth = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(auth ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // 网络层失败（fetch 抛 TypeError，cause 可能是 ECONNREFUSED/AggregateError/超时）
      // 统一映射为 PGM_UNAVAILABLE，让上层按“服务不可用”阻塞依赖记忆的任务（§8.3）
      if (err instanceof TypeError || err?.name === "AbortError" || RETRYABLE.has(err?.cause?.code)) {
        throw new PgmApiError("PGM_UNAVAILABLE", `PGM 不可达: ${path}`, 503, String(err));
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return null;
    const contentType = res.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await res.json()
      : await res.text();

    if (!res.ok) {
      const err = payload?.error ?? {};
      throw new PgmApiError(
        err.code ?? `HTTP_${res.status}`,
        err.message ?? (typeof payload === "string" ? payload : "未知错误"),
        res.status,
        err.details,
      );
    }
    return payload;
  }

  // ------------------------------------------------------------ 健康/就绪

  /** 存活检查（无鉴权，无敏感信息）。 */
  async healthz() {
    return this._request("GET", "/healthz", { auth: false });
  }

  /** 实际就绪 = 存活 + 一次授权请求（设计 §3.3：凭状态码 200 不代表兼容/有权）。 */
  async ready() {
    await this.healthz();
    await this.search({ query: "", limit: 1 }); // 授权 + 项目范围 + 协议可达性
    return { ok: true, project: this.projectId, destination: this.destination };
  }

  // ------------------------------------------------------------ 检索 / 上下文

  /**
   * 项目内检索（§9.1/§9.5）。只返回授权范围内的来源与记忆。
   * @param {{query: string, limit?: number, status?: string, knownAt?: string}} p
   */
  async search({ query, limit = 20, status = "active", knownAt } = {}) {
    return this._request("POST", "/v1/search", {
      body: {
        query,
        project: this.projectId,
        status,
        limit,
        ...(knownAt ? { known_at: knownAt } : {}),
      },
    });
  }

  /**
   * 构建上下文包（§9.3）。destination 使用实例绑定值，不接受调用方指定。
   * 返回前做两件事：schema 版本校验 + local_only 深度复核。
   */
  async buildContext({ purpose, query, budgetMaxTokens = 4000, ttlMinutes = 15 } = {}) {
    const snap = await this._request("POST", "/v1/context:build", {
      body: {
        project: this.projectId,
        destination: this.destination,
        ...(purpose ? { purpose } : {}),
        ...(query ? { query } : {}),
        budget_max_tokens: budgetMaxTokens,
        ttl_minutes: ttlMinutes,
      },
    });
    this._assertSchema(snap, CONTEXT_SCHEMA);
    if (isCloudDestination(this.destination)) {
      this._assertNoLocalOnly(snap);
    }
    return snap;
  }

  /**
   * 校验快照（§8.1）：每次模型请求 / 有副作用工具 / 外发与发布前调用。
   *
   * singleflight（§8.1.1）：
   *  - key = sessionId|snapshotId|destination|purpose 的在途并发只读分支合并；
   *  - 请求结束（成功或失败）即从 Map 移除 —— 已完成的 valid 结果绝不复用
   *    （completed_validation_cache_ttl_ms = 0）；
   *  - 有副作用的调用方应在完成后自行重新调用本方法发起“新”校验。
   */
  validateSnapshot(snapshotId, { purpose = "" } = {}) {
    const key = `${this.sessionId}|${snapshotId}|${this.destination}|${purpose}`;
    const inflight = this._inflightValidates.get(key);
    if (inflight) return inflight;

    const p = this._request("POST", "/v1/context:validate", {
      body: { snapshot_id: snapshotId, destination: this.destination },
    })
      .then((result) => {
        this._inflightValidates.delete(key);
        return result;
      })
      .catch((err) => {
        this._inflightValidates.delete(key);
        throw err;
      });
    this._inflightValidates.set(key, p);
    return p;
  }

  /** 服务端 validate 语义快捷判断：只有显式 valid 才放行。 */
  async assertSnapshotValid(snapshotId, { purpose } = {}) {
    const result = await this.validateSnapshot(snapshotId, { purpose });
    if (result?.status !== "valid") {
      throw new PgmApiError(
        "SNAPSHOT_INVALID",
        `快照 ${snapshotId} 校验结果 ${result?.status ?? "unknown"}，必须重建上下文`,
        409,
        result,
      );
    }
    return result;
  }

  // ------------------------------------------------------------ 证据

  /** 按需读取获准证据片段（服务端每次重新鉴权 + 项目校验 + 截断）。 */
  async getEvidence(eventId) {
    return this._request("GET", `/v1/evidence/${encodeURIComponent(eventId)}`);
  }

  // ------------------------------------------------------------ 候选（只写候选，无审批权）

  /**
   * 提交记忆候选（§8.1：memory.propose → POST /v1/proposals）。
   * 服务端强制 candidate 状态；本客户端不提供 confirm/reject 入口。
   * @param {{type: string, content: string, scope?: string,
   *          classification?: string, evidenceIds?: string[]}} p
   */
  async propose({ type, content, scope = "global", classification = "personal", evidenceIds = [] }) {
    return this._request("POST", "/v1/proposals", {
      body: {
        type,
        content,
        project_id: this.projectId,
        scope,
        classification,
        evidence_ids: evidenceIds,
      },
    });
  }

  // ------------------------------------------------------------ 事件回流

  /**
   * 幂等批量回流（§8.1：/v1/events:batch）。events 由 outbox 统一管理；
   * idempotencyKey 建议传首批事件键或批次哈希，服务端落 job 记录。
   * @param {object[]} events pgm.event.v1 数组
   * @param {{idempotencyKey?: string}} [opts]
   */
  async pushEvents(events, { idempotencyKey } = {}) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new Error("pushEvents: events 不能为空");
    }
    for (const ev of events) {
      this._assertSchema(ev, EVENT_SCHEMA);
      if (ev.origin === "injected_context") {
        throw new Error("回流污染防护：origin=injected_context 的事件禁止回传（§8.2）");
      }
    }
    return this._request("POST", "/v1/events:batch", {
      body: { events },
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    });
  }

  // ------------------------------------------------------------ 内部

  _assertSchema(obj, expected) {
    if (obj?.schema_version !== expected) {
      throw new ProtocolError(
        `期望 ${expected}，实际 ${obj?.schema_version ?? "(缺失)"}；` +
          `请核对 global-mem/packages/contracts 与适配器版本`,
      );
    }
  }

  _assertNoLocalOnly(snap) {
    const leaked = (snap.memories ?? [])
      .filter((m) => m.classification === "local_only" || m.classification === "secret_excluded")
      .map((m) => m.id ?? "(no-id)");
    if (leaked.length > 0) throw new LocalOnlyLeakError(leaked);
  }
}

#!/usr/bin/env node
/**
 * pgm-adapter.mjs — personal-context MCP stdio server。
 *
 * 协议：MCP stdio = newline-delimited JSON-RPC 2.0（每行一条完整消息）。
 * 实现最小方法集：initialize / ping / tools/list / tools/call。
 * 零第三方依赖；destination 绑定启动配置（env），工具调用方不能改写。
 *
 * 启动（由 Harness/宿主以子进程方式拉起）：
 *   PGM_TOKEN=... PGM_PROJECT=personal-agent PGM_DESTINATION=mtplx \
 *     node adapter/bin/pgm-adapter.mjs
 */

import { createInterface } from "node:readline";
import {
  configFromEnv,
  createClient,
  createOutbox,
  dispatchTool,
  toolDefinitions,
} from "../lib/tools.js";

const SERVER_INFO = { name: "personal-context", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

async function main() {
  let client;
  let outbox;
  try {
    const cfg = configFromEnv();
    client = createClient(cfg);
    outbox = createOutbox(cfg);
  } catch (err) {
    // 配置错误：写 stderr 后退出（stdout 只承载协议消息）
    console.error(`[personal-context] 配置错误: ${err.message}`);
    process.exit(78); // EX_CONFIG
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      replyError(null, ERR_PARSE, "JSON 解析失败");
      return;
    }
    if (!msg || msg.jsonrpc !== "2.0") {
      replyError(msg?.id ?? null, ERR_INVALID_REQUEST, "非 JSON-RPC 2.0 消息");
      return;
    }
    handle(msg).catch((err) => {
      if (msg.id !== undefined && msg.id !== null) {
        replyError(msg.id, ERR_INTERNAL, err.message);
      }
    });
  });

  async function handle(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;
      case "notifications/initialized":
        return; // 通知，无需应答
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: toolDefinitions() });
        return;
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments ?? {};
        try {
          const text = await dispatchTool(client, outbox, name, args);
          reply(id, {
            content: [{ type: "text", text }],
            isError: false,
          });
        } catch (err) {
          // 工具级错误以 result.isError 返回，让模型能看到失败原因（§4.4：明确报告失败）
          reply(id, {
            content: [{ type: "text", text: `工具失败: ${err.message}` }],
            isError: true,
          });
        }
        return;
      }
      default:
        if (id !== undefined && id !== null) {
          replyError(id, ERR_METHOD_NOT_FOUND, `方法不存在: ${method}`);
        }
    }
  }

  // 首次工具调用前先探一次就绪（§3.3），失败不阻塞 server 启动——
  // 安装/普通工具冒烟可继续，个人上下文任务会在调用时明确失败（§8.3）。
  client.ready().catch(() => {});
}

main();

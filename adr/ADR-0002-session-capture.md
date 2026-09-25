# ADR-0002 原生会话采集：直接读 dsh 会话快照

- 状态：**已采用**（2026-09-26）
- 相关：ADR-0001（Harness 集成）、设计 v0.4 §8.2（防回流污染）/ §8.3（幂等回流）/ §11（分类与脱敏）
- 决策者：Rico + Axiom

## 背景

依赖「模型/SOP 显式调用 `events:queue`」来回流会话存在结构性问题：漏记不可避免，
且遗漏不可自愈——没被调用就永远丢失，而记忆库的长期价值完全取决于数据完整性。
这是 ADR-0001 里登记的已知缺口之一，原方案是「等 dsh 插件接口锁定后再做」。

## 决策

改为**直接读取 dsh 已落盘的会话快照**做采集：

```
$DSH_HOME/sessions/<编码cwd>/session-<uuid>/session.v3.jsonl.zstd
```

即：`node adapter/bin/pgm-session-capture.mjs [--once|--watch N|--dry-run]`

理由：会话文件是 dsh 自己持久化的事实来源，属于磁盘上的稳定产物；
读它不需要任何 dsh 内部插件 API，也不依赖反编译内部实现细节之外的东西，
因此**不必等插件接口锁定**。

## 关键子决策与理由

### 1. 用结构判定过滤注入材料，而非文本匹配

会话里同一个 `user/message` 位置上会出现三类内容：

| 记录 `source.kind` | 内容性质 | 处理 |
|---|---|---|
| `"user"` | 真人输入 | ✅ 采集 |
| `"plugin"`（`plugin: "pgm-harness-adapter"`, `form: "recall"`） | PGM 召回注入 | ❌ 跳过 |
| `"plugin"`（dsh-system-prompt, `form: snapshot`）/ `"skill-catalog"` | 系统提示与技能目录 | ❌ 跳过 |

**这决定了系统是否自洁。** 若把召回注入当成用户新指令再采一次，会形成
「PGM 记忆 → 注入到会话 → 被采集回来 → 再次注入」的正反馈污染回路，
记忆库会自我放大、失真。

采用**结构判定**（`source.kind === "user"`）而不是文本特征匹配，因为结构体是
dsh 写入方明确标注的语义，比猜文本稳定。文本标记（`[PGM 个人全局记忆…]`）
仅作为第二道兜底。

### 2. 工具调用与结果默认不采集

实测会话的 `tool/result` 里出现过真实 API key（`Error: DeepSeek API error (HTTP 401)…`）。
默认关闭 `--include-tools`；即使开启或正文里用户自行粘贴凭证，仍统一走脱敏
（`sk-*` / `Bearer` / `pgm-` / `api_key=` / `ghp_` / PEM 私钥）。

助手的 `reasoning` 同理默认不采：它是模型内部推理，不代表用户意图，
采回来只会稀释记忆信噪比。

### 3. 幂等键与断点续采

- `message_id = dsh:<sessionId>:<seq>` —— 由会话与序号推导，天然稳定，
  与服务端 `source_key` 同构，重复运行不翻倍。
- 游标文件 `state/dsh/capture-cursors.json` 记录每会话已采最大 `seq`，
  增量扫描；游标只由**成功解析**的记录推进，因此写入中途造成的坏行不会被跳过。
- 幂等不依赖游标：即使游标丢失，outbox eventKey 与服务端 source_key 仍会去重。

### 4. 引入 `zstd` 外部依赖（权衡）

会话文件是**多帧 zstd 拼接**。实测 Node 22.22.2 原生 `zlib` 只能解出首帧，
流式解压在第二帧报 `Unknown frame descriptor`（同一文件 CLI 可解出 131 行）。
因此采集依赖外部 `zstd` CLI，破坏了本项目"零第三方依赖"的一致性。

**取舍结论**：接受。理由是该依赖是标准压缩工具（brew/conda/PATH 均可得），
比"漏记所有会话"的代价小得多；已按 `PGM_ZSTD_BIN` → PATH → brew → conda 顺序探测，
缺失时明确报错并给出安装提示，不做静默降级。

## 被否决的方案

| 方案 | 否决原因 |
|---|---|
| 等 dsh 插件/hook 接口锁定 | 时间不确定；当前 dsh 为 RC（0.1.5-rc.3），接口仍可能变动 |
| 由模型在每轮结束时调用 `events:queue` | 依赖模型自觉，漏记不可自愈，正是要解决的问题 |
| 正则匹配整个聊天窗口 HTML/日志 | 无结构化堆栈信息来源，判定注入不可靠 |

## 后果与风险

1. **耦合会话文件格式**：若 dsh 升级到 `session.v4`（或改加密/改存储路径），
   采集会失效。`listSessions` 找不到任何会话时返回空而非报错——
   需要靠 **events 数量突降**这一可观测信号来发现（当前尚未接告警）。
2. **真人与注入的定义权在 dsh**：若未来某类真人输入被标为非 `user` kind，
   会静默漏采。缓解：`--dry-run` 统计里暴露 `skippedInjected` 与 `candidates` 的比值，
   异常时可人工核对。
3. **隐私**：这是把真实对话写入长期记忆的动作。当前默认 `classification=personal`、
   默认不采工具。已写入事件可用 PGM `/v1/deletions:preview` 按 `source_key`
   精确核实与删除（key 形如 `dsh-harness|local|<sessionId>|dsh:<sessionId>:<seq>|1`）。
4. **规模**：`planCapture` 目前全量读入解析，POC 规模（百条级）够用；
   会话进入千条量级需改为流式 + 更精细游标。

## 验收证据（2026-09-26）

- 单元测试：`session-capture.test.mjs` 11/11（注入跳过、文本兜底、reasoning 排除、
  工具默认排除、6 类凭证脱敏、幂等键稳定、截断、空正文拒绝、游标续采、空目录安全）。
- 真实数据：4 个会话 / 342 条记录 → 生成 21 条事件，跳过注入 24 条，坏行 0，
  脱敏 0，截断 0；outbox 21 条全部 `committed`。
- 服务端确认：`GET /v1/evidence/dsh:session-3411f079…:9` → HTTP 200，
  `project_id=personal-agent`、`classification=personal`。
- 幂等确认：二次运行 `events: 0`（游标生效，零重复扫描）。

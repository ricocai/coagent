---
name: context-pack
description: 从 PGM 取授权上下文、区分决定/建议/未决、产出交接包并回流事件的流程。当任务开始需要项目背景、或用户要求"带上记忆/上下文"时使用。
---

# context-pack Skill

按 `sop/context-pack.md` 执行。要点：

1. `pgm-ctl ready` 失败 → 明确报阻塞，不用本地旧文件代替当前有效记忆。
2. `pgm-ctl build --purpose "<用途>"` 取上下文；记录 snapshot_id 与版本。
3. 输出严格三分：用户已确认决定 / 助手建议（未确认）/ 未决问题。
4. 重要结论附 `[E:ev_xxx]` 或 `[M:mem_id@v]` 引用。
5. 长期记忆更新只走 `pgm-ctl propose`（候选），不自行确认。
6. 结束前 `pgm-ctl events:flush` 回流本轮原生事件（幂等）。
7. 模型请求/副作用工具/外发前 `pgm-ctl validate <snapshot_id>`，非 valid 重建。

缺少证据时的处理：宁可标注"未验证/查不到"，不得用推测冒充事实。

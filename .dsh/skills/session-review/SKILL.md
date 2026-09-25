---
name: session-review
description: 会话/任务结束后的复盘：核对产物哈希、记录五项复盘、把用户纠正分流为反馈草稿或记忆候选。用户说"复盘/总结这次任务"时使用。
---

# session-review Skill

按 `sop/session-review.md` 执行。要点：

1. 用 runs/runs.jsonl 最新记录核对产物哈希与实际文件一致；不一致要说明。
2. 五项：是否完成、哪里需人工纠正、用时、关键来源可回溯性、下次只改什么。
3. 用户纠正分流：任务口径 → feedback/round-N.md；长期规则 → `pgm-ctl propose --type preference`（候选），Agent 无权直接生效。
4. 不删改历史记录，错误照实留档。

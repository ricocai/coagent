---
name: research-brief
description: 基于给定材料产出带引用的研究简报（一句话判断、≤5 条事实带来源、推断分层、反证与最小实验）。用户要求"研究/简报/评估某技术"时使用。
---

# research-brief Skill

按 `sop/research-brief.md` 执行。要点：

1. 先过 context-pack 取项目上下文（snapshot_id 保留）。
2. 只根据实际读取的材料分析；末尾列资料时间与缺口。
3. 输出：一句话判断 → 机制与问题 → ≤5 条事实（每条带 [E:...]）→ 项目价值（推断要标注）→ 不适用与反证 → ≤半天实验与成功/失败指标。
4. 自检：抽查 2 条关键主张回读证据原文，确认材料支持主张——主张不被材料支持时改主张或降级为推断。
5. 记账：`personalctl run record --stage research-brief --file <产物>`。

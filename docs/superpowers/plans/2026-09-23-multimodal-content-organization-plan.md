# 多模态内容组织实施计划

## 目标

在现有 Stage A 可信 Evidence 适配边界上，增加一个可运行的统一内容组织最小闭环：图片、用户文字和 final ASR 都能独立产生候选观察；系统可以生成事件/故事卡片；用户明确关系优先；AI 关系按可解释评分自动展示或进入待确认；列表摘要和详情原文分离。

## 范围

本轮实现：

- `photo`、`user_text`、`final_asr` 三类 ContentItem；
- `ContentObservation`、`StoryUnit`、`AssociationCandidate` 的运行时契约；
- 确定性 Fake Provider/Organizer；
- 一个图片 + 一段文字 + 一段 final ASR 的故事 fixture；
- 显式关系优先、AI 评分、阈值分带、冲突和撤回测试；
- 全栈交接文档和运行命令。

本轮不实现：

- 生产数据库、ORM、Redis、消息队列和对象存储；
- 文件正文解析、作品理解、真实模型/API、Memory 持久化；
- 完整前端页面和真实用户账号权限。

## 默认规则

- v0.1 一个 StoryUnit 对应一个用户可浏览的事件/故事卡片；不做嵌套故事。
- 一个内容只有一个 primary StoryUnit；其他关系进入候选关联。
- 用户明确关系永远优先，AI 不能覆盖。
- AI score `>=0.80` 进入 `ai_auto`，`0.55–<0.80` 进入 `needs_review`，低于 `0.55` 标记 `not_selected` 并保留审计记录。
- 标题最多 32 字，摘要最多 120 字；原文永远保留。
- 评分是工程评分，不等于校准概率。

## 任务 1：冻结运行时契约

受影响文件：

- `src/lib/algorithms/classification/content-organization.ts`
- `harness/classification/content-organization.test.mjs`

行为：

- 使用 Zod 严格校验 ContentItem、Observation、StoryUnit、AssociationCandidate；
- 校验 scope、Evidence 引用、原文 support、标题/摘要长度、评分范围和状态组合；
- 对用户明确关系禁止带 AI score；对 AI 关系要求 method、score 和 evidenceRefs；
- 任何 withdrawn 内容都不能成为 active 故事成员。

验证：契约正例、字段缺失、跨 scope、越权证据、冲突状态和撤回状态。

## 任务 2：实现确定性 Fake Organizer

受影响文件：

- `src/lib/algorithms/classification/content-organization.ts`
- `harness/classification/content-organization.test.mjs`

行为：

- 根据输入 observations 生成稳定的故事 ID、标题候选和摘要候选；
- 标题/摘要只引用输入中的 Evidence，不凭空生成日期、人物和地点；
- 用户显式绑定直接生成 `user_confirmed`；
- AI 关联使用时间、地点、事件/主题、人物线索的可解释加权评分；
- 高分自动挂接，中文显示“AI 关联”；中分进入 `needs_review`；低分不挂接；
- 冲突、scope 不一致和 withdrawn 内容直接阻止自动关联。

验证：同一输入稳定输出、用户关系优先、高/中/低分三档、冲突阻断、删除传播和双主体隔离。

## 任务 3：交接和验证

受影响文件：

- `docs/algorithms/CLASSIFICATION_STAGE_A_HANDOFF.md`
- `docs/algorithms/CLASSIFICATION_STAGE_A_VERIFICATION.md`
- `docs/algorithms/CLASSIFICATION_STATUS_2026-09-21.md`

行为：

- 写明统一内容库、StoryUnit、AI 关联评分和页面映射；
- 给全栈工程师提供 Fake 运行方式、输入输出示例和后续替换真实 Provider 的边界；
- 记录测试分母、未完成真实模型验证和后续进入条件。

## 提交边界

1. `docs: record multimodal content decisions and plan`
2. `feat: add multimodal content organization contracts`
3. `feat: add deterministic story organizer and tests`
4. `docs: hand off multimodal content organization`

每个提交只改当前任务相关文件。禁止 push、PR、merge、部署和真实 API 调用。

## 完成标准

- Fake/本地组织链可运行；
- 新增契约和组织测试全部通过；
- 原有 `npm run test:classification`、`npm run typecheck`、分类 secret scan 通过；
- 文档明确候选与用户确认、工程评分与真实概率、Mock 与真实模型效果之间的区别；
- 工作树无未跟踪历史项目或生产配置。

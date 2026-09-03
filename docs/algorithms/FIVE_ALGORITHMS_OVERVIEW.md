# SGX 五大算法定义与团队协作说明

> 文档状态：`draft_for_owner_review`
> 版本：`0.1.1`
> 日期：2026-09-04
> 主要读者：产品、内容、算法、工程、标注、运营、科研团队，以及参与项目的 AI Agent

## 1. 一句话定位

SGX 不是一个通用聊天壳，也不是自动编造回忆录的工具。它要成为一个以老人自主权为前提、由真实证据支撑的生命记忆与家庭陪伴系统：帮助老人低压力地讲述、整理、确认和使用自己的生命记忆，并逐步提供个性化服务。

五大算法分别解决五个问题：

1. 内容里有什么？——自动分类归纳。
2. 接下来怎样问最合适？——AI 访谈。
3. 什么应该被记住、怎样正确使用？——Life Memory。
4. 怎样基于了解提供有价值、不过度打扰的服务？——用户洞察与推荐。
5. 怎样在严格边界下研究认知变化并提供安全支持？——认知状态研究、干预与风险流程。

这五个算法共享证据和权限基础，但不能由一个“大 prompt”混在一起完成。

本文件记录 2026-09-04 项目/产品负责人的当前决策：方案 C 已确认，先开发多模态分类归纳的契约、合成 fixtures、fake provider、确定性 baseline 和离线 harness。它不自动改变根 PRD 的当前产品 UI/MVP 发布范围；真实数据、外部模型、pilot 和产品上线另行审批。

## 2. 共同底座：证据、确认、权限与版本

所有算法都遵循同一条主链：

```text
文字 / 语音 / 图片 / 经授权的交互事件
                  ↓
内容哈希可验证的 EvidenceRecord
                  ↓
算法候选：标签、事实、问题或建议
                  ↓
用户确认 / 修改 / 拒绝 / 撤回
                  ↓
可使用的 Memory、访谈上下文或个性化服务
```

共同规则：

- 原始证据、算法推断和用户确认事实必须分层保存。
- 每条结论都要知道来自哪里、由哪个版本产生、谁确认过。
- 不确定时可以拒判或追问，不能为了“智能感”补全事实。
- 内容主体决定个人隐私、长期 Memory 和对外可见范围。
- 贡献者可以修改或撤回自己的原声和补充内容。
- 圈管理员只管理成员和秩序，不能越权公开敏感内容。
- 产品使用和科研参与分开；不参加研究不影响正常使用。
- 删除、撤回和权限变化必须传播到索引、缓存和派生内容。
- “原始证据不可篡改”不是永久保留：AI 不能静默覆盖原文；纠错、权限变化和删除使用追加版本与墓碑表达。

## 3. 算法一：多模态自动分类归纳

### 3.1 定义

从图片、文字和语音转写中识别人、事、时、地、物、场景和主题，生成可以组合筛选、可以追溯和可以修正的多标签候选。

### 3.2 用户价值

- 家庭不必手工逐张整理照片。
- 老人可以从某一年、某个地方或某位人物自然进入回忆。
- 后续访谈和 Memory 能找到相关材料，而不是在所有历史中盲目搜索。

### 3.3 输入与输出

| 输入 | 输出 |
|---|---|
| 照片、EXIF、文字说明、语音转写、当前老人主体、已确认 Memory | 时间、地点、人物候选、事件、场景、主题、内容类型、质量、重复关系、证据和置信度 |

### 3.4 不做什么

- 不把人脸相似直接写成真实姓名。
- 不用模糊视觉线索编造精确年代和地点。
- 不从照片推断疾病、家庭矛盾、人格和动机。
- 不自动改变分享权限。

### 3.5 当前阶段

`scope=P0`，`maturity=M0`，`workflow_status=in_progress`，`evidence_status=design_only`：已确认方案 C 和多模态范围，当前正在完成规格、接口与测试基线。现有代码只有粗粒度关键词分类，不能称为算法完成。

## 4. 算法二：AI 访谈

### 4.1 定义

AI 访谈不是“多问问题”，而是在每一轮选择最合适的下一动作：倾听、承接、追问一个问题、确认、换题、暂停或安全退出。

### 4.2 主要目标

在低压力前提下获得更多可确认、可追溯的生命记忆。被倾听感、疲劳、安全退出和不诱导是不能被牺牲的体验约束。

### 4.3 输入与输出

| 输入 | 输出 |
|---|---|
| 当前对话、相关照片、已确认 Memory、已问内容、疲劳/拒绝信号、敏感边界 | 下一访谈动作、一个问题或承接语、引用证据、停止/换题决定 |

### 4.4 不做什么

- 不连续审问，不一次提出多个复杂问题。
- 不暗示不存在的经历，不把 AI 写的故事当老人原话。
- 不假扮子女、学生或家庭成员。
- 不以对话轮数、时长或故事文采作为唯一成功标准。

### 4.5 当前阶段

`scope=future_after_A1`，`maturity=M1`，`workflow_status=partial`，`evidence_status=engineering_partial`：项目已有语音会话、访谈 prompt、简单追问和打断基础，但存在新旧访谈实现并存，尚未形成统一、可评测的 Next Best Question 系统。

## 5. 算法三：分层 Life Memory

### 5.1 定义

Memory 不是把聊天记录全部塞进 prompt。它是一个分层、可追溯、可更正、可冲突共存、可遗忘和可删除的生命记忆系统。

### 5.2 三层结构

1. 证据层：保存原始图片、音频、文字和来源，不能被 AI 改写覆盖。
2. 确认事实与事件层：保存经确认的人物、地点、事件、时间和关系；冲突版本并存。
3. 对话使用层：保存偏好、禁忌、临时上下文和检索结果，分别管理有效期和用途。

故事、时间线和洞察属于派生内容，不得反向成为原始事实。

### 5.3 用户价值

- AI 能在后续会话中正确引用老人已经确认的经历。
- 用户能够查看“为什么系统记得这件事”。
- 改口、纠错、撤回和删除后，系统不会继续使用旧内容。

### 5.4 不做什么

- 不把每次对话摘要都当长期事实。
- 不跨家庭、跨圈层检索未授权信息。
- 不把家属描述自动当成老人本人确认。
- 不让禁忌话题以普通 Memory 的方式被主动提起。

### 5.5 当前阶段

`scope=shared_foundation`，`maturity=M1`，`workflow_status=partial`，`evidence_status=engineering_partial`：已有 MemoryCandidate 的确认、拒绝、编辑和确认后 MemoryCard，但抽取粒度、检索、冲突、权限、撤回和删除传播仍需建设。

## 6. 算法四：用户洞察与个性化推荐

### 6.1 定义

基于用户允许范围内的确认 Memory 和行为反馈，生成可解释、可关闭、不过度打扰的个性化服务建议。家庭圈是主要关系空间，未来可以扩展学生圈、朋友圈等用户创建圈层。

### 6.2 可能输出

- 适合继续访谈的话题或照片。
- 老人可能愿意回看的内容。
- 家庭成员可以低压力发起的互动建议。
- 内容缺口，如“这组照片还缺少地点确认”。
- 面向老人的服务、活动或内容推荐。

### 6.3 每条洞察的要求

- 能解释依据来自哪些已授权证据。
- 明确是事实、推断还是建议。
- 有有效期、频率限制、目标受众和关闭/反馈入口。
- 权限先于关系权重：家庭圈默认相关性更高，但不能因此越权读取。

### 6.4 不做什么

- 不给用户贴固定人格标签。
- 不评价子女是否孝顺、家庭关系是否健康。
- 不利用敏感信息操纵消费或制造焦虑。
- 不把认知风险分数作为普通推荐特征。

### 6.5 当前阶段

`scope=future`，`maturity=M0`，`workflow_status=planned`，`evidence_status=design_only`：当前只预留 InsightRecord 和事件接口，先完成分类归纳与 Memory 证据闭环，再开发推荐算法。

## 7. 算法五：认知状态研究、干预与风险流程

### 7.1 必须拆成三层

1. P0 适老化：大字幕、慢语速、减少步骤、重复提示、明确返回路径。任何符合基本安全条件的老人都可以使用。
2. P1 科研观察：额外自愿加入、单独同意、纵向采集、shadow mode；个体预测不直接影响老人、家属和线上产品。
3. P2 风险提示与转介：只有临床合作、伦理审批、外部验证和人工复核完成后才可能启用。

### 7.2 不做什么

- 不从一次普通聊天诊断 MCI、痴呆或认知衰退。
- 不把口音、方言、听力、教育程度、情绪、噪声或 ASR 错误当成认知问题。
- 不让模型直接通知家属或输出疾病概率。
- 不把产品留存、对话时长或互动次数当作临床效果。

### 7.3 紧急安全链路

跌倒、胸痛、自伤表达等紧急生命安全事件使用独立链路，不与认知趋势模型混合。本项目当前没有授权自动报警；未来需要明确授权联系人、复核责任和失败处置。

### 7.4 当前阶段

- `cognitive_accessibility`：`scope=P0`，`maturity=M0`，`workflow_status=planned`，`evidence_status=design_only`；当前允许开展适老化设计和工程准备。
- `cognitive_research`：`scope=P1`，`maturity=M0`，`workflow_status=blocked`，`evidence_status=design_only`，`block_reason=研究同意和正式协议未完成`。
- `cognitive_risk_referral`：`scope=P2`，`maturity=M0`，`workflow_status=blocked`，`evidence_status=design_only`，`block_reason=临床、伦理和外部验证门禁未满足`。

## 8. 五算法怎样协作

```text
原始图片/文字/语音
        ↓
自动分类归纳 ───────┐
        ↓            │
候选 MemoryClaim     │
        ↓ 用户确认    │
Canonical Memory     │
   ↓            ↓    │
AI 访谈        用户洞察
   ↓ 新证据      ↓ 反馈事件
   └──────→ EvidenceRecord

认知研究：独立 consent、独立数据与 shadow runtime
紧急安全：独立触发、复核与联系链路
```

重要约束：

- 分类归纳和访谈只能产生候选，不能自行确认事实。
- Memory 只向其他算法提供当前主体、当前用途和当前权限允许的内容。
- 用户洞察不能读取未授权内容或 P1 认知预测。
- 认知研究不得把派生故事和 AI 改写文本当作原始临床观测。

## 9. 产品线与科研线

| 产品线 | 科研线 |
|---|---|
| 目标是可靠、有用、低压力的用户体验 | 目标是回答预先定义的研究问题 |
| 所有安全用户均可使用 | 用户额外自愿加入，不加入不影响产品 |
| 使用生产权限和产品数据生命周期 | 独立 consent、去标识化和冻结数据集 |
| 允许快速迭代，但必须可回滚 | 方案、切分、指标和版本需预先冻结 |
| 结果可以显示给用户确认 | P1 个体预测处于 shadow mode |

两条线可以共用 schema、标注工具和评测代码，但不能直接共用未治理的数据、结论和发布权限。

研究成果进入产品的路径：

```text
离线研究结果
→ 冻结外部测试
→ 安全与隐私审查
→ shadow mode
→ 小流量产品 pilot
→ 产品负责人发布决策
```

## 10. 权限与角色：保持简单

老人端不显示复杂角色切换。系统内部只需要理解：

- 内容主体：决定自己的隐私、长期 Memory 和可见范围。
- 贡献者：可以修改或撤回自己的原声和补充内容。
- 授权查看者：只能看被授予范围内的内容。
- 圈管理员：管理成员和群组秩序，不拥有内容公开权。

同一人在不同圈层可能拥有不同权限，但 UI 应以当前任务自动呈现，而不是要求老人理解多重角色模型。

## 11. 数据标注与质量岗位

推荐设置一名“银发 AI 研究数据标注与质量专员”，主要职责：

- 按冻结规范标注图片、转写、实体、事件、时间和不确定项。
- 不猜测缺失事实；无法判断时标为 `uncertain`。
- 记录证据片段、争议原因和数据质量问题。
- 维护标注版本、失败样本和修正记录。
- 与独立复核员对关键样本交叉复核。

产品负责人不承担日常标注，只负责定义产品目标、审批规范和裁决少数争议样本。标注数据不能自动成为科学金标准；一致性和复核结果必须单独报告。

岗位完整职责、4 周用户反馈、算法调优和两人协作流程见 `docs/algorithms/DATA_ANNOTATION_FEEDBACK_AND_OPTIMIZATION_OPERATIONS.md`。

## 12. 统一成熟度、工作与证据状态

团队使用四个独立字段，避免“写了文档就算完成”：

| `maturity` | 含义 |
|---|---|
| `M0` | 定义/规格阶段，没有可运行算法证据 |
| `M1` | 有可重复工程原型，效果尚未离线验证 |
| `M2` | 冻结数据上完成离线评测和错误分析 |
| `M3` | 完成目标用户受控 pilot，报告完整分母 |
| `M4` | 受控在线实验支持限定产品价值 |
| `M5` | 正式研究和外部验证支持限定科学主张 |

```yaml
scope: P0 | P1 | P2 | shared_foundation | future | future_after_A1
maturity: M0 | M1 | M2 | M3 | M4 | M5
workflow_status: planned | in_progress | partial | blocked | complete
evidence_status: design_only | unverified | engineering_partial | verified | failed | stale
```

当前状态：

| 算法 | `scope` | `maturity` | `workflow_status` | `evidence_status` | 下一门禁 |
|---|---|---|---|---|---|
| 自动分类归纳 | `P0` | `M0` | `in_progress` | `design_only` | SPEC 审批、契约/harness、最小基线 |
| AI 访谈 | `future_after_A1` | `M1` | `partial` | `engineering_partial` | 统一运行入口、冻结策略与评测 |
| Life Memory | `shared_foundation` | `M1` | `partial` | `engineering_partial` | 分层 schema、冲突/删除/检索测试 |
| 用户洞察 | `future` | `M0` | `planned` | `design_only` | 分类和 Memory 证据闭环完成 |
| 认知适老化 | `P0` | `M0` | `planned` | `design_only` | 定义非诊断性的体验适配验收 |
| 认知研究 | `P1` | `M0` | `blocked` | `design_only` | 研究同意与正式协议 |
| 认知风险与转介 | `P2` | `M0` | `blocked` | `design_only` | 临床、伦理和外部验证 |

## 13. 团队工作流程

每个算法功能按照同一流程推进：

1. Plan Gate：本轮做什么、不做什么、用户价值是什么。
2. Source Gate：评估可复用开源项目、license 和自研理由。
3. Design Gate：冻结状态机、接口、数据、错误和评测。
4. Implementation Gate：小范围实现，先写聚焦测试。
5. Evaluation Gate：自动化、人工清单和失败分母完整。
6. Release Gate：隐私、安全、灰度、回滚、版本和责任人齐全。

一个新功能对应一个清晰 Git commit。设计文档、实现代码、测试证据和效果结论分别管理，不能相互替代。

## 14. 给产品与内容团队的判断方法

面对一个新需求，依次问：

1. 它解决老人或家庭的什么真实问题？
2. 输入证据来自哪里，用户是否知道并同意？
3. 输出是事实、候选、推断还是建议？
4. 出错时谁会受影响，用户怎样纠正或退出？
5. 是否需要跨圈层、敏感内容或认知信息？
6. 该能力当前处于设计、工程验证、pilot 还是科研验证？

如果这些问题答不清，功能不能进入实现或对外宣传。

## 15. 给 AI Agent 的规范化定义

```yaml
system_name: SGX Life Memory System
primary_product_goal: evidence-constrained, low-pressure life-memory support for elders and families
algorithms:
  multimodal_classification:
    role: produce traceable multi-label assertions from image, text, and transcript evidence
    may_write: proposed assertions only
    forbidden: identity guessing, clinical inference, permission changes
  ai_interview:
    role: choose the next safe, low-pressure interview action or question
    may_write: interview actions and new raw evidence
    forbidden: leading questions, impersonation, automatic fact confirmation
  life_memory:
    role: govern evidence, confirmed claims, retrieval, conflict, consent, correction, and deletion
    may_write: candidates; canonical facts require authorized confirmation
    forbidden: mixing generated stories with raw evidence
  user_insight:
    role: generate explainable, permission-scoped personalized suggestions
    may_write: expiring insight candidates
    forbidden: personality judgment, family scoring, use of cognitive risk as ordinary feature
  cognitive_safety:
    role: P0 accessibility; P1 consented shadow research; P2 only after clinical and ethics gates
    may_write: isolated research observations under valid consent
    forbidden: product diagnosis, automatic family alerts, mixing with emergency safety chain
shared_invariants:
  - subject_id_required
  - provenance_required
  - permission_before_relevance
  - uncertainty_may_abstain
  - generated_content_is_not_raw_evidence
  - deletion_propagates
  - product_and_research_are_separated
```

## 16. 本轮需要负责人审阅的重点

1. 五大算法的名称是否需要面向外部换成更通俗的产品名称。
2. 自动分类 P0 的边界是否接受“匿名人物聚类，但不自动命名”。
3. 回收站是否采用建议的 30 天默认值。
4. 产品负责人是否接受“内容主体优先确认、贡献者确认自己补充内容”的默认流程。
5. 这些成熟度状态是否作为团队周报、研发看板和飞书知识库的统一口径。

# 2026-09-27 SGX 执行记录

## 本日目标

回答并落实以下架构问题：图片两两送入 VLM 的成本与扩展性、固定 `0.80/0.55` 人工确认带、家庭参考积累、跨家庭泛化以及本地轻量模型与 VLM 的分工。

## 已确认事实

- Stage A 已先选每张受影响图片的有限候选，再执行 VLM `relate`；它不是全图库全 pair。`extract <= Δ`、`relate <= I×K`，其中 `I` 是受影响内容数，当前调用为串行。
- `content-organization.ts` 当前在本地枚举全部 active 内容对。246 项会形成 30,135 对，超过现有 Schema 最多 30,000 条 association 的边界。
- `association-rules.1` 的 `0.80/0.55` 是未校准工程阈值，不是模型概率或真实准确率。
- 当前仓库已经参考 Immich 和 LibrePhotos 的增量索引与纠错思想，没有复制其源码或引入其服务。
- 现有三条链仍缺 `Stage A → ContentObservation` 和独立文字/final ASR 真实 extractor 的正式接线。

## 用户已明确的产品方向

- 大多数正常场景应自动分类和归纳，人工确认只处理真正高影响或有歧义的问题。
- 系统应随家庭历史参考增加而减少人工确认。
- 算法必须做跨场景、跨家庭泛化验证。
- 需要评估本地聚类、CLIP/SigLIP、OCR 和向量检索与多模态模型的组合，而不是只依赖单一 VLM。

## 本轮新增确认

- AI 可以自动完成智能相册的分类、分组、标题、摘要、时间线和筛选，并标示“AI 整理”；人物身份、敏感事实和长期 Memory 使用独立确认机制。
- 第一轮真实产品测试以事件/故事自动成组为主，多维标签、搜索和聚类属于同一能力的组成部分。
- taxonomy 需要支持超出当前五维的版本化扩展。
- 输入覆盖智能相册上传和家庭双端互传；后者可能是纯文本、纯语音、纯图片或任意图文语音组合。
- 一段文字或 final ASR 可能描述一张图片、多张图片或整个批次。当前 Stage A 的单图强绑定不足以覆盖该产品语义。
- 产品负责人提出先阻止高风险自动动作，并在风险较高时请求确认；该原则已在下一轮正式确认为按影响分级。

## 第二轮产品决策

- 正式采用按影响分级：高风险暂停相应动作并针对性确认，中风险复核或批量确认，低风险自动整理并允许纠错。
- 多图片未指定单图说明时，文字/final ASR 保存为批次级 Evidence；AI 只提出图片关联候选，不能擅自改写为单图事实。
- 家庭双端互传内容进入智能相册体系，可暂处“待整理”视图，同时进行低风险自动分类归纳和适度批量确认。
- “待整理”和“智能相册”应是同一内容的不同状态/视图，避免重复媒体副本；待整理期限和到期呈现仍待确认。

## 第三轮产品决策

- 待整理任务保留 7 天：第 3 天轻提醒，第 7 天从首页待办收起；低风险 AI 整理结果留在相册，高风险项保留在专门未确认列表。
- 明确生物识别授权后，系统可自动建立未命名人物组；姓名和亲属关系由用户确认，未来内容可继续自动归纳。
- Memory 分层使用：未经确认的 AI 候选可支持相册搜索和生成访谈问题，但只有用户确认的具体身份、关系和人生事实进入长期 Memory。
- 自动人物归纳的计算路径可采用家庭内 reference top-K，不需要全图库两两比较；当时待决的 provisional/stable 规则已在下一轮确认。

## 第四轮产品决策

- 人物 reference 采用渐进成熟：一次确认建立 provisional reference，2–3 张跨年代、角度或质量的确认参考后升级为 stable reference；稳定参考的高确定匹配可自动归纳。
- 采用后台渐进处理；上传立即返回并逐步显示结果，候选体验目标是数秒出现基础进度、30 项内容约 2 分钟完成，正式 SLA 由目标服务器实测冻结。
- 采用混合部署：服务器本地处理 OCR、embedding、近重复和授权后人物聚类；VLM API 处理困难语义、冲突和故事摘要。
- 产品真实测试需区分 T0 离线算法、T1 本地产品 Alpha、T2 全栈集成和 T3 小规模真实用户 Pilot；是否正式采用该四级顺序仍待产品负责人确认。

## 第五轮产品决策

- 正式采用 `T0 → T1 → T2 → T3`；当前算法工作包只负责完成 T0/T1，但必须提供全栈可接入的契约、运行方式、测试证据和交接材料。
- T1 选择先做轻量本地分类实验台，不直接开发正式智能相册页面；浏览器上传、服务端算法调用、结果解释和纠错必须真实跑通。
- T0/T1 使用 30–50 组真实素材；进入 T3 前另建跨家庭独立 holdout。首批材料不能被描述为跨家庭泛化或产品效果证据。

## 本日形成的设计

- 新增 [混合召回、按需 VLM 与渐进自动化 Spec](../superpowers/specs/2026-09-27-classification-hybrid-retrieval-adaptive-automation-spec.md)。
- 新增 [T0/T1 实施与全栈交付计划](../superpowers/plans/2026-09-27-classification-t0-t1-delivery-plan.md)。
- 新增 [目标流程图](../../figures/sgx-classification-hybrid-retrieval-adaptive-flow.md)。
- 更新 [分类算法完整指南](../algorithms/CLASSIFICATION_ALGORITHM_COMPLETE_GUIDE.md)，把下一阶段顺序改为：适配器与稀疏候选 → 本地特征 Spike → VLM router → scorer 校准 → 家庭参考 → 产品闭环。

核心目标链：

```text
Evidence 门禁
→ 本地增量特征
→ Blocking/ANN top-K
→ 硬 veto
→ 可校准 scorer
→ VLM 按需裁决
→ 受约束稀疏图聚类
→ StoryUnit
→ 高影响确认
→ FamilyReference / 独立 MemoryCandidate Gate
```

## 推断与建议

- 先部署 embedding/OCR/索引通常比先自托管完整 VLM 更能直接降低调用数、时延和隐私暴露面。
- 小规模 Spike 应分别用 exact search 检验 ANN 技术召回、用人工 same-event/same-story 标注检验业务候选召回；已有 PostgreSQL 时再评估 pgvector HNSW，不应在当前阶段先引入独立向量数据库。
- 人脸识别应默认关闭，并单独处理生物识别授权、商用权重许可和跨年龄真实评测。
- `0.80/0.55` 应继续作为 baseline，不应原地修改语义；生产策略需新版本、真实 calibration 和 holdout Gate。

## 当前决策门禁

T0/T1 顺序、责任边界、轻量实验台和首批真实材料规模已经确认。H0/H1 和 T1 本地工程闭环已完成。仍需在 exploration 后、查看独立 holdout 前冻结语义数值 Gate。

混合召回架构已获产品方向批准；具体本地模型/checkpoint、许可、资源和数值阈值仍必须经过 H2 Source Gate 与真实数据验证。30–50 组真实素材、人工真值和授权是当前实际门禁。

## 候选下一任务与结束标准

工程主线的下一步是执行 T0-B/T0-C：

1. 收集并授权 30–50 组真实图片、用户说明和 final ASR；
2. 完成独立人工真值、leakage group 和固定分母；
3. 运行离线 preflight 并冻结 manifest/truth digest；
4. 先跑 deterministic/Fake，再按单独批准运行真实 Provider；
5. 输出候选召回、错误合并/拆分、拒判、费用、请求数和时延报告；
6. 完成 T1 30 项人工操作验收并交给全栈进入 T2。

## 验证记录

- 文档规划和随后完成的本地工程门禁均不构成真实准确率、真实产品效果或本地模型性能结论。
- `git diff --check`：通过。
- Mermaid CLI 在当前依赖中不可用，因此保留 `.mmd` 与 Markdown Mermaid 预览；未宣称 PNG 已渲染验证。

## 当日工程实施结果

用户确认只由本窗口完成 T0/T1，并要求形成可直接交给全栈的工程包后，实际完成了：

- `0043171`：冻结 hybrid retrieval、FamilyReference 和 DecisionPolicy 契约；
- `d1cabef`：组织器支持稀疏候选输入；
- `f4f78ec`：Stage A Observation/Group 接入 `ContentObservation`；
- `fded904`：增加 bounded exact top-K 召回基线；
- `42b86d4`：冻结图文/final ASR、单图/多图/批次和家庭互传 ingestion v2；
- `d1393da`：接通 ingestion 到 StoryUnit 的输入桥；
- `7d7cd42`：增加供未来 30–50 组真实素材使用的 manifest/truth 离线门禁；该提交内的测试 fixture 非真实素材；
- `fe9b0da`：增加 loopback BFF、本地任务与确定性 Provider；
- `44f845d`：修正 AI 生成 StoryUnit 被用户显式 binding 错误升级为 `user_confirmed` 的边界；
- `d9d971f`：增加 `/classification-lab` 浏览器实验台及 loopback 专用启动命令；
- `44371d0`：增加确认、拒绝、移出、拆分、合并、删除和撤权七类 append-only 动作。
- `3841dd0`：把 T0 自动化中的 30 组程序生成素材明确改名为 synthetic contract fixture，避免误报成真实素材验收。

浏览器实际提交了 2 张非真实的程序生成测试图、用户原文和 final ASR：服务端形成 4 份独立 Evidence、1 个 StoryUnit，耗时 30ms，模型调用 0、费用 ¥0.00。随后通过独立 `accept_story` 动作把故事从“AI 整理候选”升级为“用户已确认”，动作审计可见。删除与撤权只在临时目录自动化测试中执行，没有在浏览器验收中破坏样本。

168 项回归中的“30 组”同样是运行时构造的 2×2 PNG/文字契约 fixture，只证明真实素材 preflight 工具能校验结构、哈希、分母和场景覆盖；它不是 30 组真实照片，也不能计入 T0/T1 真实验证。

浏览器验收发现并修复两项问题：

1. 通用 `npm run dev` 监听 `0.0.0.0`，与实验台 loopback 门禁冲突；新增 `npm run classification:lab` 固定监听 `127.0.0.1`；
2. 用户明确绑定文字与图片不等于确认 AI 生成的标题/故事；现在关系仍为 `user_confirmed`，StoryUnit 保持 `ai_candidate`，只有 `accept_story` 可升级。

最终工程门禁：

- `npm run test:classification`：168/168 通过；
- `npm run typecheck`：通过；
- 使用仅限构建进程的临时 JWT 值执行 `npm run build`：通过；
- `npm run test:classification:secret`：通过；
- `git diff --check`：通过。

全栈权威交接文件为 [图文分类 T0/T1 全栈交接手册](../algorithms/CLASSIFICATION_T0_T1_FULLSTACK_HANDOFF.md)。当前未完成项是 30–50 组真实素材、独立真值、T0 固定分母真实评测和 T1 30 项人工验收；因此不能声称真实准确率、跨家庭泛化或产品上线完成。

## 下一任务

主线下一任务是 T0-B/T0-C 真实数据验证：产品负责人准备 30–50 组已授权真实图片、用户说明和 final ASR；算法侧运行离线 preflight、冻结真值和固定分母，再决定具体真实 Provider 调用。H2 本地 OCR/embedding/近重复 Spike 可以并行准备，但在 license manifest 与真实数据门禁完成前不形成正式选型结论。

为避免新的 AI 把生成图片或自动化 fixture 当作真实数据，新增 [真实多模态数据准备 AI 执行任务书](../algorithms/CLASSIFICATION_REAL_DATA_AI_TASK_BRIEF.md)。任务书冻结了真实数据定义、30–50 组覆盖矩阵、授权边界、目录结构、人工真值独立性、preflight 命令和完成标准。AI 只负责盘点、结构化和门禁，不得生成素材补足真实分母。

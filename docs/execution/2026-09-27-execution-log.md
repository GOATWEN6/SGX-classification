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

## 本日形成的设计

- 新增 [混合召回、按需 VLM 与渐进自动化 Spec](../superpowers/specs/2026-09-27-classification-hybrid-retrieval-adaptive-automation-spec.md)。
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

产品负责人指出现有候选方案仍可能在架构、设计目标、验收指标、性能与产品联动上存在不合理处。H0/H1 暂不开始，先完成以下决策：

1. 是否采用 T0 离线算法 → T1 本地产品 Alpha → T2 全栈集成 → T3 真实用户 Pilot 的顺序；
2. 各级真实数据数值 Gate；
3. 本地分类实验页与正式智能相册页面的功能边界。

此前的混合召回方案继续作为可审阅 Draft，不作为已经批准的实现方案。

## 候选下一任务与结束标准

上述决策完成后，候选的下一次提交执行 H0 + H1：

1. 冻结 `AssetFeature`、`RetrievalCandidate`、`SparseAssociationInput`、`FamilyReference`、`DecisionPolicy`；
2. 先写 250 项输入不允许全量 pair 的回归；
3. 让内容组织器消费稀疏候选边；
4. 实现 `Stage A Observation/Group → ContentObservation`；
5. 运行分类回归、typecheck、密钥扫描和 diff 检查；
6. 一个小提交结束，不安装模型、不调用付费 API、不接生产数据库。

## 验证记录

- 本轮为文档与架构规划，不构成真实准确率、真实产品效果或本地模型性能结论。
- `git diff --check`：通过。
- Mermaid CLI 在当前依赖中不可用，因此保留 `.mmd` 与 Markdown Mermaid 预览；未宣称 PNG 已渲染验证。

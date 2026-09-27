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

1. AI 未经逐项确认时可以自动整理到哪一层；
2. 误合并、误拆分和人工负担的优先级；
3. 第一轮真实产品测试的主能力；
4. 确认交互、长期 Memory 权威边界和敏感内容策略；
5. 首版性能预算、本地模型部署范围和真实数据验收 Gate。

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

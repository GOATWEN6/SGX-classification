# 分类 v1 契约与第一批交付

> 2026-09-29：semantic scoring v2 现有五份 strict draft-07 Schema：
> [`classification-scoring-policy-v2.schema.json`](classification-scoring-policy-v2.schema.json)、
> [`classification-truth-v2.schema.json`](classification-truth-v2.schema.json) 和
> [`classification-semantic-scoring-cases-v2.schema.json`](classification-semantic-scoring-cases-v2.schema.json)，以及 E2 新增的
> [`classification-semantic-score-report-v2.schema.json`](classification-semantic-score-report-v2.schema.json) 和
> [`classification-semantic-runtime-v2.schema.json`](classification-semantic-runtime-v2.schema.json)。
> 它们分别冻结七类语义结果及匹配/风险/时间/冲突/固定分母规则，input-only 盲审 synthetic truth
> 及来源绑定，正反评分 case 的输入、期望、证据种类、时间字段和 policy/truth bytes hash，以及
> E2 固定分母报告与单次 runtime request/result。runtime 地点预测必须显式提供
> `placeKind=named|generic`，避免把普通地点类别和无依据的具体地名混为一类。
> policy 明确 `aggregateScore=null`，功能 Gate 的数值阈值仍为 `null`；旧内容组织
> baseline 的 `0.80/0.55` 不是模型置信度、真实准确率或本评测 Gate。`g025` 画面可见的
> `2001-07` 只能保存为 `role_unknown` observation，在角色澄清前不能升级为
> `event/capture/scan/upload`，也不单独构成同角色冲突。配套 fixtures 和 focused test 见
> [`harness/classification/README.md`](../harness/classification/README.md)。当前 policy/truth fixture 的
> `claimBoundary` 是 `synthetic_functional_only`，case fixture 则是
> `offline_contract_fixture_only`；E2 oracle 报告同样是 `offline_contract_fixture_only`，其 safety Gate
> 固定为 `not_applicable_oracle_fixture`。这些产物只能支持合成功能真值、离线契约规则与异常处理检查，不证明
> 真实模型准确率、真实家庭泛化或产品效果。

> 2026-09-29：新增实验产物登记契约
> [`classification-artifact-registry-v1.schema.json`](classification-artifact-registry-v1.schema.json)。
> 它只保存 Git 外持久运行目录中的文件路径、字节数、SHA-256、版本身份、授权摘要和
> provenance，不嵌入媒体、用户原文、模型 raw response、approval 正文或凭据。真实模型 lane
> 强制绑定模型身份和授权摘要；offline replay 强制通过 `sourceRegistryRefs` 锚定父 registry。
> 离线 writer/verifier 位于 `harness/classification/artifact-registry.mjs`；该契约证明文件
> 完整性和证据边界，不证明模型准确率或产品效果。

> 2026-09-27：新增 T0/T1 真实素材离线冻结契约
> [`classification-t0-real-media-v2.schema.json`](classification-t0-real-media-v2.schema.json)，
> 固定 `specVersion=2.0.0`、30–50 组分母、真实用户授权来源、exploration / T1 validation
> 防泄漏分区和独立真值结构。它不包含媒体原件，也不是模型准确率结果；跨字段、文件哈希、
> MIME/尺寸、路径安全和覆盖矩阵由
> `src/lib/algorithms/classification/t0-real-media.ts` 离线校验。

> 2026-09-27：新增多模态入口契约
> [`classification-ingestion-v2.schema.json`](classification-ingestion-v2.schema.json)，
> 固定 `specVersion=2.0.0`，覆盖 `album_upload / family_transfer`、纯文本、
> final ASR、单图/多图/批次绑定以及家庭互传 3/7 天待整理策略。未指定图片的
> 用户说明保留为批次级 Evidence；AI 只能增加 `ai_candidate` 单图/多图绑定，
> 不能把它升级为用户事实。运行时跨字段校验位于
> `src/lib/algorithms/classification/ingestion-contract.ts`。

> 2026-09-27：混合召回与渐进自动化新增语言无关契约
> [`classification-hybrid.schema.json`](classification-hybrid.schema.json)，覆盖
> `AssetFeature`、`RetrievalCandidate`、`SparseAssociationInput`、
> `FamilyReference`、`DecisionPolicy` 和 `DecisionPolicyResult`。运行时语义校验位于
> `src/lib/algorithms/classification/hybrid-contract.ts`。新策略默认 `shadow`；
> 原始 embedding 不进入契约，人物特征必须携带独立生物识别 consent；AI 结果不能产生
> `user_confirmed` 或直接写长期 Memory。

本批只提供合成数据的 integration contract：Schema、生成的 TypeScript 类型、正反 fixtures、Fake Provider 和接入保护函数。上传/API、持久化 Job、用户确认/修改 UI、Memory adapter 和删除传播由全栈后续接入；这些尚未验收，`algorithm_ready=false`、`integration_ready=false`。

## 冻结计划与文件所有权（2026-09-07）

基线 `cc8f545`；分支 `codex/classification-contract-v1`。指定的四份 anchor documents 和 AGENTS.md 与主目录逐字一致。主目录未跟踪的 `ai-frame-main/`、`银发AI相框-PRD:MVP.md` 不复制、不修改、不纳入提交。

| 文件范围 | 所有者 | 本批完成条件 |
|---|---|---|
| `contracts/*.schema.json` | Astra | JSON Schema draft-07 唯一规范源；封闭字段、固定 v1 枚举 |
| `src/lib/algorithms/classification/` | Astra | 生成类型；结构和语义校验；Fake 六场景；超时/取消/晚到保护 |
| `scripts/classification-*.mjs`、`package*.json` | Astra | 原生 Node 测试、TypeScript 编译、生成一致性检查 |
| `harness/classification/` | Astra | 合成正反 fixtures、行为测试、PRD traceability、运行示例 |
| 只读探索和最后复核 | Terra / Luna | 不改文件、不提交；主智能体核验反馈 |

提交边界：先提交 Schema/类型及基础契约验证，再提交 Fake Provider/行为测试和交付证据。必要保护属于本批；不搭建新的数据库、队列或产品 API。

## v1 语义决定

- 最新交接 §6/7 优先于旧 SPEC 表格：输入只收 `image/text/transcript`，转写必须 `final=true`；撤回状态统一 `withdrawn`，不接受 `revoked`。
- Job 保留七种状态；Provider 返回其中五种终结状态。`conflicted` 是 Assertion 状态，Job 返回 `needs_review`。`no_assertion` 是 facet 拒判记录，不是 Job/Assertion 状态。
- `schemaVersion=1.0`；event/theme taxonomy 的真实集合尚未冻结，样例使用 `fixture-taxonomy.1`，不得用作真实评测标签集。
- `duplicate` 独立 facet 表达重复关系；人物只表达文本提及、F1 区域或受开关/独立 consent 约束的匿名簇。没有自动身份确认字段。
- Provider 只能返回 `proposed/conflicted`；用户确认、修改、拒绝、撤回使用独立 review 契约，产品授权服务负责校验本人/明确代理权限。不得直接写入现有 MemoryCandidate/MemoryCard。
- `sourceRef` 只保存受保护的逻辑 ID，不接受 URL/凭据；真实 Provider 的受控对象解析器待后续实现。Fake 不读取对象。Provider 请求省去 owner/contributor/visibility 等产品审计字段。
- 权限不是客户端声明：调用方必须从服务端授权服务取得最新 context，并在落库事务中再次核验生命周期/版本。纯保护函数的单测不等于完整 ACL、并发、幂等存储或删除传播验收。

## Open-Source First

核对 [Ajv v6.14.0](https://github.com/ajv-validator/ajv/tree/v6.14.0) 和 [Zod v3.25.76](https://github.com/colinhacks/zod/tree/v3.25.76) 的官方项目与本机包；两者 MIT。现有 Zod v3 用于旧 API，不能直接验证本批语言无关的 JSON Schema。采用锁文件已包含的 Ajv 6.14.0（MIT），将其从间接开发依赖声明为直接运行依赖，无新增包/模型下载；仅校验仓库内可信 Schema，禁用类型转换、字段移除和默认值写入。未复制上游源码；分发包时保留其许可证。

类型生成器只处理本仓库使用的 Schema 结构，遇未知关键字失败；数值范围、格式、跨字段约束仍由运行时 Ajv 和语义保护函数检查。领域保护和确定性 Fake 为 SGX 契约专有的小型适配代码；无需引入通用工作流框架或真实模型依赖。

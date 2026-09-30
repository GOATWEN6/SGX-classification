# SGX 自动分类与归纳：下一阶段执行计划

> 日期：2026-09-29  
> 分支：`codex/classification-contract-v1`  
> 起点提交：`08a37c6`  
> 当前 Prompt/Guard：`sgx-five-facets.12`  
> 状态：E0–E2 已完成；E3a composition adapter 与 E3b execution lifecycle 已通过本地门禁；E3c 已完成独立单图 real-smoke 页面和 9 次真实调用，但尚未接入 v2 lifecycle；下一项为 E3c lifecycle 集成与多图 T1

> 2026-09-30 进展：用户授权总计 10 次、¥5、0 自动重试、不做人脸匹配；已使用 9 次、累计记账 ¥0.110598，保留 1 次页面人工测试。详情见 [T0 真实模型冒烟报告](../../algorithms/evidence/2026-09-30-classification-real-smoke-t0.md)。该证据证明单图真实链路可运行，不代表完整 T1、真实家庭准确率或生产能力。

> 2026-09-29 审计补充：执行前必须同时遵循 [当前问题总表与修订后的执行边界](../../algorithms/CLASSIFICATION_CURRENT_ISSUES_AND_EXECUTION_PLAN_2026-09-29.md)。旧 `/private/tmp` 冻结包、真实运行和 replay 目录当前已不存在，因此不得把“旧 6 例离线重算/保存响应 replay”写成可直接执行步骤；时间角色以现行 Prompt 的 EXIF-only `capture` 规则为准。

## 1. 本阶段要得到的结果

本阶段的目标是把“真实模型已经能被 CLI 调用”推进到“真实 Stage A 能从本地分类实验台安全运行，并可用冻结的 validation 批次验收”。完成时应具备：

1. 一套不会把合理同义词、合理附加标签误判为严重错误的版本化 truth 与评分规则；
2. 一个只在服务端持有凭据的真实 Stage A 实验台 Provider；
3. 图片、用户文字和 final ASR 从浏览器上传后，经过真实模型、Guard、内容组织和人工动作的完整 `T1-Local Product Alpha` 页面链；
4. 一份可交给全栈工程师继续 T2 的接口、环境变量、错误恢复和已知限制说明；
5. 在获得新授权后，对 14 组 `t1_validation` 只运行一次冻结验收，不再依据 validation 调 Prompt 或规则。

本阶段不搭建生产数据库、ORM、Redis、消息队列、对象存储或正式账号鉴权；这些属于全栈 T2。也不做人脸身份匹配，不把合成素材结果写成真实家庭准确率。

## 2. 当前起点和不可覆盖的证据

- 已完成 6/6 次 `qwen3.7-flash-2026-07-15` 真实请求，0 自动重试，累计记账 ¥0.045918；批准额度已经用完。
- 原始结果必须保留：2 succeeded、2 needs_review、2 failed。后续离线修复不能覆盖这些历史状态。
- g001、g025 的保存响应已在 `.12` 下精确离线重放 2/2 通过；这只证明 Guard 修复有效，没有产生新 API 调用。
- E0 检查点曾在受限沙箱得到非 HTTP 250 pass / HTTP 相关 28 fail（`listen EPERM 127.0.0.1`）；E1 改动后全量为 284/284，E2 完成后为 303/303；E3a 历史检查点为 328/328，E3b 当前受控 loopback 全量为 393/393。此前一次 expired-cache 409 与随后 CLI shutdown 超时未复现，保留为历史间歇性记录。
- `/classification-lab` 当前只支持 `deterministic` Provider；`lab-store.ts` 也明确拒绝其他 Provider 结果。
- 现有 Stage A Provider、Evidence adapter 和 Stage A→内容组织 adapter 可复用，不再另写一套模型调用链。
- 旧 r5、两个真实运行和 `.12` replay 的报告仍在 Git，但报告引用的 `/private/tmp` 原始目录当前已经不存在；必须为新批次建立持久证据根，不能从文档反向伪造旧响应。
- E1 已冻结 `sgx-scoring-policy.2.2026-09-29` 与新 truth revision `sgx-truth.2.v3-derived-e1-2026-09-29`；claim boundary 为 `synthetic_functional_only`。g025 的可见 `2001-07` 保存为 `role_unknown`，不与 `event:1998-summer` 形成同角色冲突。
- E2 已实现 `sgx-semantic-scorer.2.0.0`、strict oracle report/runtime Schema、离线 CLI 和逐文件 freeze manifest；E1 + E2 focused 25/25、E2 检查点全量 303/303，独立复审 P0/P1/P2 均为 0。整个过程没有网络或 API 调用、没有读取凭据、额外费用 ¥0。历史 r5 exact rescore、功能数字 Gate 和真实分布效果仍未完成。
- E3a 已实现纯 `StageALabPlan` 和组合器：单图/多图/批次 Evidence 分流，三类 ID 映射，Correction allowlist，文字 `sourceType + quote` 回查，Stage A provider/context hash 校验，严格 Edge/Group、人物匹配拒收和合并 retrieval validation。它只证明离线集成契约，不代表页面或真实 Provider 已接通。
- v1 Lab 当前幂等键仍不含 Provider/model/prompt/scorer，同步 POST 也仍无法在真实调用期间执行取消或撤权。独立 v2 E3b 路径已经修复完整 run identity、两阶段执行、取消/隐私竞态和 late-result Gate，但尚未通过 E3c 接入 HTTP/UI，因此页面行为仍不能写成已修复。

## 3. 执行顺序

```text
E0 持久证据 registry 与旧产物缺失记录（已实现）
  ↓ Gate 0
E1 语义与评分口径冻结（已完成）
  ↓ Gate 1
E2 评分器 v2 与固定分母报告（已完成）
  ↓ Gate 2
E3a 纯 Stage A → Lab composition adapter（已完成）
  ↓
E3b 两阶段 runner / CAS / cancel（已完成本地门禁）
  ↓
E3c 真实 Stage A Provider factory
  ↓ Gate 3（零付费调用）
E4 本地页面真实模型 T1-Local Product Alpha 冒烟
  ↓ Gate 4（需要一次新授权）
E5 14 组 t1_validation 冻结合成功能验收
  ↓ Gate 5（需要单独的新授权）
E6 全栈 T2 交接包更新
```

当前直接进入不读取密钥、不联网、不产生费用的 E3c mock/HTTP 接线准备。E4、E5 只有在各自清单和上限可检查后，才请求一次明确授权。

## 3.1 E0：先建立持久证据 registry

E0 已实现 registry strict Schema、writer/verifier、CLI 和旧临时产物 missing ledger。旧 raw response 与 replay 目录仍然缺失；找不到的旧响应不能重造，从源数据重新生成的材料必须使用新 revision 和 digest。Stage A runner 自动 finalization 仍留到 E3 接线。

## 4. E1：冻结通用语义和风险口径（已完成）

### 4.1 要解决的问题

6 例探索暴露的四个分歧不能靠针对样例写特例解决：

|案例|问题|冻结为通用规则|
|---|---|---|
|g007|`聚会` 与 `家庭聚会`、`capture` 与 `event`、`桌面` 与 `庆典`|没有家庭关系证据时，`聚会` 是更安全的核心标签；按现行 Prompt，`capture` 仅接受可信原始 EXIF，用户文字/final ASR 描述某次活动中的拍摄日期按 `event`；有视觉依据的附加场景允许存在|
|g011|只有年份矛盾，却额外声明 event conflict|冲突必须有两个互相排斥的同维度候选或明确的同维度否定证据；不能由 time conflict 自动传播为 event conflict|
|g023|核心 `户外` 正确，同时给出 `自然景观`|受控 taxonomy 内且有 Evidence 的附加标签记为 supported extra，不作为严重错误|
|g025|历史输出声明 time conflict、只保留 1998，并漏掉图片中可见的 2001|用户说明支持 `event:1998-summer`；没有 EXIF/流程 provenance 的像素日期 `2001-07` 保存为 `role_unknown` 观察并请求角色澄清，不自动形成同角色冲突|

### 4.2 评分结果不再只有“对/错”

每个维度至少区分：

- `required_core`：缺失会影响主要分类或故事归纳；
- `acceptable_variant`：粒度更保守但语义成立；
- `supported_extra`：有 Evidence 的额外受控标签；
- `missing_required`：应有但漏掉；
- `unsupported_extra`：没有足够 Evidence 的额外断言；
- `unsafe_false_positive`：人物身份、关系、敏感事实、具体时间地点等高影响无依据断言；
- `conflict_incomplete`：声明冲突但未保留冲突双方或对应证据。

这些是评测标签，不是产品中要求用户确认的概率阈值。旧 `0.80/0.55` 继续只作为内容组织 baseline。

### 4.3 Gate 1

- 规则能解释四个现有分歧，也能用于未见样例；
- 不包含 `if photoId === g007` 一类样例特判；
- 用户原文、AI 标题、AI 摘要、候选事实和用户确认事实仍然分层；
- 人物身份、敏感事实和长期 Memory 的确认边界不变。
- 四个争议样例由只看输入与冻结政策、不看模型输出的盲审流程裁决并留下 ledger；`supported_extra` 必须在运行前预定义，不能由模型自己的 Evidence 引用循环证明。

Gate 1 已完成：`sgx-scoring-policy.2.2026-09-29`、`sgx-truth.2.v3-derived-e1-2026-09-29`、scoring policy/truth/scoring cases 三份 strict Schema、正反 fixtures、盲审 ledger 与 SHA-256 freeze manifest 已冻结。`node --test harness/classification/semantic-scoring-v2.test.mjs` 为 6/6；本阶段没有网络/API 调用、凭据读取或新增费用。

此 Gate 只证明合成输入的语义合同与冻结流程，claim boundary 为 `synthetic_functional_only`。它没有改写 r5 truth、原始 6 次请求的 2 succeeded / 2 needs_review / 2 failed，也没有恢复缺失的 raw response。历史 r5 当前不能 exact rescore；E2 的后续完成状态见下一节。

全量分类回归是独立门禁：E1 检查点为 284/284，通过 E2 后的当前受控 loopback 记录为 303/303。此前一次 expired-cache 409 与随后 CLI shutdown 超时未复现，作为历史间歇性问题保留；各阶段结果分别记录，不互相覆盖。

## 5. E2：实现评分器 v2 并冻结新产物（已完成）

### 5.1 实现范围

实际产物：

- `harness/classification/semantic-scoring-v2.mjs`：纯函数评分器；
- `contracts/classification-semantic-score-report-v2.schema.json`：固定分母报告；
- `contracts/classification-semantic-runtime-v2.schema.json`：单次 runtime request/result；
- `scripts/classification-semantic-score.mjs`：互斥的 `--cases` Oracle 与 `--run` Runtime 模式；
- `harness/classification/semantic-scoring-v2-implementation.test.mjs`：19 个实现门禁；
- `docs/algorithms/evidence/CLASSIFICATION_SEMANTIC_SCORER_V2_FREEZE_2026-09-29.json`：E1/E2 原始 bytes SHA-256 绑定。

采用版本化、向后兼容方式：历史 `sgx-truth.1` 和 r5 报告只读保留；E2 同时读取 E1 已冻结的 `sgx-truth.2` 与 `sgx-scoring-policy.2`，不再二选一。它们分别表达 required/optional/forbidden、角色/冲突/来源/风险，以及 taxonomy/alias/父子层级/错误严重度。不得原地改写历史 truth、manifest、运行目录、失败记录或 E1 freeze manifest。

回归至少覆盖：

1. event 父子粒度与保守标签；
2. time role 的语义区分；
3. supported extra 不被计为严重错误；
4. unsupported extra 仍被惩罚；
5. 冲突不跨维度传播；
6. conflict incomplete 可被识别；
7. failed、not_run 和 needs_review 仍留在固定分母；
8. scoring policy、truth、manifest 和素材均有 SHA-256 绑定。

### 5.2 Gate 2（通过）

- 历史 r5 证据完全未覆盖；
- scorer 使用 E1 版本化 fixtures 离线验证“核心正确、可接受变体、支持的额外标签、真正错误”；旧 6 例原始产物当前缺失，不得伪称已完成 exact rescore；若后续按 hash 找回，再追加独立复算报告；
- 评分器测试、全量分类回归、typecheck、secret scan、diff check 通过；
- 冻结 `.12` Prompt、taxonomy、Guard 和 scorer 版本；进入 validation 后不再调参。

验证结果：冻结 Oracle 16/16；E1 + E2 focused 25/25；E2 检查点全量分类回归 303/303；typecheck、secret scan、syntax 和 diff check 通过；独立终审 P0/P1/P2 均为 0。`aggregateScore=null`，功能数字阈值仍等待真实数据校准。本 Gate 只证明合成 fixture 的评分合同可执行，不代表模型准确率、产品安全或真实家庭效果。

提交边界：

1. `bcb10c7 docs(classification): freeze semantic scoring v2`
2. `feat(classification): add semantic scorer v2`

## 6. E3：把真实 Stage A 接入本地实验台

### 6.0 Source Gate 与拆分

Source Gate 结论为 `PASS_WITH_CONDITIONS`：复用现有 `ApiVisionProvider`、`ClassificationEngine`、`adaptTrustedStageACatalog`、`adaptStageAForOrganization`、Node `AbortSignal` 与文件 store。本阶段不新增数据库、Redis、生产队列或通用存储依赖，也不复制上游代码。

E3 分三个小提交推进：

1. **E3a composition adapter（已完成）**：纯函数完成 Evidence/photo/content ID 映射、单图与批次说明分流、time role/precision、多个 Evidence supports、版本化 `placeKind`、Correction allowlist、文字原文支持校验、Provider/context hash 与严格 Edge/Group 校验；不接网络、凭据、API、store 或 UI。
2. **E3b execution lifecycle（已完成本地门禁）**：见 [`2026-09-30-classification-lab-execution-lifecycle-spec.md`](../specs/2026-09-30-classification-lab-execution-lifecycle-spec.md)。独立 v2 路径已实现完整 frozen run identity（含全部 association 语义、`semanticContext/budgetPolicy`）、pending→processing runner、claim 后立即安装 controller/deadline、首轮 trusted guard 后创建 executor、numeric CAS、immutable envelope 冲突拒收、closed-world completeness/provenance Gate、用户明确 contents association 精确保留、结构化高影响候选复核、strict product/redacted view、durable privacy ledger/fence 与关键读写线性化、v2 action 幂等/CAS、取消/撤权/删除/timeout、晚到结果拒收，以及 orphan pending 清理和 privacy replay recovery。生命周期聚焦测试 65/65、全量分类回归 393/393，typecheck、secret scan 与 diff check 均通过。
3. **E3c provider factory（部分完成）**：已完成受控单图 real-smoke Provider、服务端凭据、授权/费用 ledger、原始响应与运行证据、页面接线；仍需将它接入 E3b v2 lifecycle，并补齐多图、异步 polling、取消/撤权/删除、晚到结果和正式 artifact registry。

E3a 验证结果：受控 loopback 全量分类回归 328/328，typecheck、secret scan 和 `git diff --check`
均通过；`externalCalls=0`、未读取凭据、额外费用 ¥0。该 Gate 只覆盖 batch-isolated Lab 的离线
集成契约。E3b 已完成竞态、隐私、action、recovery 回归和全量门禁。E3c 单图 real-smoke 已完成并取得真实调用证据，但它是有界 T0 入口，尚未替换为 E3b 生命周期执行器。

### 6.0.1 E3b 最终门禁结果与 E3c 入口

E3b 最终门禁已覆盖 claim→controller 取消窗口、preflight/commit guard 卡住时的统一 deadline、factory/profile mismatch、foreign/incomplete output、全部 association 语义进入 content identity、矛盾 active/withdrawn 快照拒收、同 identity 下 immutable envelope/规范原文/asset manifest 漂移拒收、用户明确 association 遗漏或篡改、withdrawn association、人物与高影响风险复核、`stage_a_mock` Schema/lifecycle double、多 Job privacy fan-out 与 submit fence、live-guard TOCTOU、部分删除产品泄露、action replay/CAS、orphan cleanup 和 recovery privacy replay。结果为生命周期聚焦测试 65/65、全量分类回归 393/393；早期 22/22 不再作为完成证据。

E3c 的第一项不是立即付费调用，而是实现真正的 `stage_a_mock` factory/transport adapter，再把 v2 factory/executor 接到服务端 HTTP 202 与页面 polling，证明上传、轮询、取消、失败恢复、结果展示和动作矩阵均走新生命周期。E3b 测试中的 `stage_a_mock` 只是在确定性输出上改 metadata 的 lifecycle/Schema double。真实 `stage_a_real` 仍须经过 artifact/usage、派生图 provenance、预算预检和用户精确授权。

### 6.1 服务端数据流

```text
Browser multipart upload
→ Next.js /api/classification-lab
→ IngestionEnvelope + Evidence + Binding
→ Lab Stage A adapter
→ ApiVisionProvider（Qwen/GLM，服务端）
→ Stage A Guard / cache / authorization recheck
→ adaptStageAForOrganization
→ sparse retrieval + StoryUnit organization
→ file-backed local lab store
→ 页面展示 AI 标签、故事、证据、费用、时延和复核项
```

实现优先复用：

- `ApiVisionProvider`
- `adaptTrustedStageACatalog`
- `ClassificationEngine`
- `adaptStageAForOrganization`
- `organizeSparseContent`

不使用通用聊天 `OpenAICompatibleProvider` 代替 Stage A，因为它缺少图片哈希、授权目录、预算、原始响应审计和分类语义 Guard。

### 6.2 多模态绑定规则

- 明确绑定到一张图片的 `user_text/final_asr` 可以进入该图的 Stage A 证据；
- 指向多张图片或未指定单图的说明继续作为独立或批次级 Evidence；第一版不复制成每张图片的确定事实；
- Stage A 可以提出说明与图片的候选关联，内容组织器可以消费候选，但只有用户动作能升级为确认关系；
- 纯文本和纯 final ASR 仍由文本抽取与内容组织路径处理，不为调用视觉模型而制造空图片。

### 6.3 Provider 模式与安全边界

`CLASSIFICATION_LAB_PROVIDER` 扩展为：

- `deterministic`：现有离线基线；
- `stage_a_mock`：真实适配器 + 本地 mock transport；
- `stage_a_real`：真实适配器 + 已批准的服务端 API。

`stage_a_real` 必须满足：

- 浏览器响应、页面源码、job.json、日志和 Git 中均无 API key；
- Keychain 只在启动服务时注入当前进程，不要求用户重复输入，不写 `.env`；
- 缺模型、缺授权、授权过期、图片哈希变化、撤权、删除、限流、超时和非法输出都有稳定错误码；
- 默认 0 自动重试；真实模式限制单批图片和最大请求/费用，不能因页面一次上传无限调用；
- 结果记录真实 `modelVersion`、`promptVersion`、请求数、token、费用和 latency；
- `lab-store.ts` 用严格 Schema 接受真实 Provider 结果，不能简单移除校验。
- `contentDigest` 与执行 `runId` 分离；run identity 绑定完整 Provider/model/prompt/guard/adapter/taxonomy/scorer/config/place policy、authorization/context revision、attempt、`semanticContext` 和 `budgetPolicy`，防止真实模式复用 deterministic 旧任务。
- POST 先创建 pending job，再由受控 runner 启动；Provider 接收 `AbortSignal`，取消/撤权后的晚到结果必须拒收。
- 页面允许的图片大小与 Provider 上限统一；如生成模型派生图，必须保留原图/派生图 hash 和转换 provenance。
- `event/capture/scan/upload` 与 precision 必须进入内容组织，不能只留下时间字符串。

### 6.4 Gate 3：零付费调用验证

- mock transport 覆盖成功、拒判、needs_review、非法输出、限流、超时和取消；
- 使用明确标注的 mock fixtures 证明页面适配链可消费 `.12` 形状；只有在旧脱敏真实响应按 hash 恢复后才追加 exact replay，不能用新造 JSON 冒充真实响应；
- 覆盖双家庭、多主体、旧授权、删除、撤权和晚到结果；
- 页面仍可在 `deterministic` 模式回退；
- 相同输入切换 Provider/model/prompt 时产生新 run，同配置重放保持幂等；
- 运行中取消、撤权和晚到结果拒收通过两阶段 runner 实测；
- `npm run test:classification`、`npm run typecheck`、`npm run test:classification:secret`、`npm run build` 和 `git diff --check` 通过；
- 不发生网络调用、凭据读取或额外费用。

建议提交边界：

1. `feat(classification): add stage-a lab provider adapter`
2. `test(classification): cover real-provider lab boundaries`
3. `docs(classification): document local provider switching`

## 7. E4：本地页面真实模型 `T1-Local Product Alpha` 冒烟

E3 通过后，先生成一个可检查的冒烟清单，写明：素材 ID、图片数量、预计 Stage A extract/relate 请求数、模型、Prompt、最大 token、费用上限、0 重试、停止条件和输出目录。然后一次性请求授权。

建议只覆盖三个互补场景，而不是重复跑同一类图片：

1. 单图 + 用户文字：检查五维抽取与 Evidence；
2. 两图 + 批次说明或 final ASR：检查候选关联、StoryUnit 和不擅自绑定；
3. 冲突或图片内提示词：检查 `needs_review`、局部隔离和安全降级。

实际批准单位必须是“API 请求数”，不能把“3 个页面场景”直接当成“3 次请求”。先由离线 preflight 计算 extract/relate 的最坏请求上限。

### Gate 4

- 浏览器上传到结果展示走的是真实 Stage A Provider；
- 三类场景均有固定状态和可追溯 Evidence，页面无未处理异常；
- 接受、移出、拆分、合并、拒绝、删除、撤权和失败恢复至少各验收一次；
- 删除或撤权后旧结果不可继续用于展示、搜索候选或后续组织；
- 成本、请求数和时延不超过授权；
- 失败保留原始记录，不自动覆盖或静默重跑。

## 8. E5：14 组 `t1_validation` 一次性冻结合成功能验收

### 8.1 运行原则

- 使用 Gate 2 已冻结的 Prompt/Guard/taxonomy/scorer；
- validation truth 在运行前冻结并绑定 hash；
- validation 不用于继续调 Prompt、规则或评分口径；
- 0 自动重试，所有 failed/not_run 保持在固定分母；
- 不做人脸匹配；
- 运行前另行提交 exact manifest、最大 API 请求数和费用上限供用户批准。

### 8.2 功能验收 Gate

合成 validation 用来判断工程和功能完整性，采用严重性 Gate：

- `unsafe_false_positive = 0`；
- 跨家庭、跨主体、撤回内容和旧授权被使用的次数均为 0；
- 图片内提示词改变业务分类的次数为 0；
- 14/14 任务均有最终状态和原始证据，不能从分母中消失；
- 自动整理项都能追溯到 Evidence；
- 高风险断言只能进入 `needs_review`，不能静默成为用户确认事实或长期 Memory；
- 语义差异按 Gate 2 的类别报告，不用旧 `0.80/0.55` 充当准确率阈值。
- E1 已冻结 required-core 与功能报告字段，E2 已产出可执行的固定分母语义结果；E3–E5 仍须验证运行时拒判、故事成组/拆分和页面链。具体功能阈值须在 exploration/T1 校准后、查看 validation 前另行版本化冻结。全量 `no_assertion/needs_review` 不能只因安全项为 0 而通过。

这项结果命名为 `T0-Synthetic Functional Gate`，只代表真实模型在合成场景上的冻结功能验收。30–50 组授权真实内容属于独立的 `Real Distribution Gate`，没有真实数据时分母保持 0，不与本 Gate 混称。

若 hard Gate 失败，停止并归因；不在 validation 上继续修规则后重跑。修复后需要形成新的冻结版本和新的批准批次。

## 9. E6：全栈交付

更新以下权威入口：

- `docs/algorithms/CLASSIFICATION_ALGORITHM_COMPLETE_GUIDE.md`
- `docs/algorithms/CLASSIFICATION_T0_T1_FULLSTACK_HANDOFF.md`
- `docs/algorithms/CLASSIFICATION_STATUS_2026-09-21.md`
- 当日 `docs/execution/` 记录

交付包必须让全栈工程师能回答：

1. 浏览器调用哪个 endpoint、上传什么字段；
2. Fake、mock transport 和真实 Provider 如何切换；
3. 哪些配置是普通配置，哪个值只能来自 secret storage；
4. Job、Evidence、候选、确认、删除和撤权的状态如何流转；
5. T2 需要替换哪些 adapter：文件存储、对象存储、队列、鉴权和物理删除；
6. 哪些结果可以用于相册搜索，哪些只能作为候选，哪些才允许进入长期 Memory；
7. 如何复现自动化检查和人工页面验收。

## 10. 完成定义

只有同时满足以下条件，才把当前算法 T0/T1 工作包交给全栈：

- truth/scoring policy v2 已冻结并有哈希，可执行 scorer 和固定分母报告通过 Gate 2；
- `.12` Prompt/Guard/taxonomy 不再使用 validation 调参；
- 真实 Provider 通过服务端接入，浏览器无法获得密钥；
- 本地页面完成真实模型 `T1-Local Product Alpha` 冒烟及生命周期动作验收；
- 14 组 validation 完成一次固定分母运行，或明确记录 hard fail 与阻断原因；
- 自动化门禁和 secret scan 通过；
- 文档准确区分合成数据功能证据、真实模型工程证据、真实家庭效果和生产能力；
- 工作树干净，每个结果用小提交保存，可逐个回退。

## 11. 用户需要配合的时间点

现在不需要用户准备新素材、重新输入密钥或决定数据库方案。

只有两个时间点需要用户操作：

1. E3 全部离线 Gate 通过后，批准 E4 的精确模型、API 请求数、费用上限、素材清单和停止条件；
2. E4 通过后，批准 E5 的冻结 14 组 validation manifest、最大 API 请求数和费用上限。

其他工程和文档工作直接推进。

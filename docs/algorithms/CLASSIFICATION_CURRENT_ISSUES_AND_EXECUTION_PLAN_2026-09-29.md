# SGX 自动分类与归纳：当前问题总表与下一阶段执行计划

> 日期：2026-09-29
> 工作分支：`codex/classification-contract-v1`
> 盘点基线：`4ea1c79`
> 当前 Prompt/Guard：`sgx-five-facets.12`
> 当前 E1 truth：`sgx-truth.2.v3-derived-e1-2026-09-29`
> E1 claim boundary：`synthetic_functional_only`
> 适用范围：图片、用户文字说明和 final ASR 的自动分类、故事归纳、智能相册组织、复核与后续 T2 交接

## 1. 结论

当前项目已经具备一条可运行的 Stage A 算法链、严格契约、预算与授权保护、合成测试集、真实 Qwen CLI 调用报告和本地分类实验台。E1 已冻结版本化语义 policy/truth、四例 input-only 盲审和正反 fixture；可执行 scorer 仍属于 E2。当前仍未形成“浏览器上传 → 真实模型 → Guard → 故事归纳 → 用户动作”的完整 `T1-Local Product Alpha` 闭环，也没有完成冻结的 `T0-Synthetic Functional Gate`。

最先要做的不是继续扩大真实 API 调用，而是依次解决五个阻断项。E0 registry 核心和 E1 语义冻结已在本轮实现，后续从 E2 scorer 开始：

1. **E0 已实现**：为后续实验建立非临时、可校验的受控证据目录；
2. **E1 已冻结，E2 待实现**：统一时间角色和 truth/scoring policy v2，再让 scorer 消费冻结数据；
3. 把现有 Stage A Provider 作为服务端 adapter 接入 `/classification-lab`；
4. 修复 Provider 版本不参与幂等键、同步运行无法中途取消的问题；
5. 用 mock transport 完成零费用页面闭环，再申请一次小规模真实页面冒烟。

E2–E3 可以立即执行，不需要用户重新准备素材、输入密钥或决定数据库方案。新的付费请求只有在离线 Gate 全部通过并形成精确清单后再单独申请。

## 2. 本文所说的“全部问题”边界

本文盘点的是当前自动分类与归纳 T0/T1 以及可交给全栈工程师的 T2 接口问题，不包含 SGX 的 ASR、TTS、VAD、实时语音和硬件主线。问题分为：

- **P0**：不解决就不能完成 `T1-Local Product Alpha` 的真实页面闭环；
- **P1**：不一定阻塞首轮页面冒烟，但不解决就不能形成可信的 `T0-Synthetic Functional Gate`、后续 Real Distribution Gate 或稳定全栈交付；
- **P2**：不阻塞算法窗口的 T0/T1，但会阻塞生产 T2；
- **已修复历史问题**：保留原因和防复发措施，避免重复排查。

## 3. 当前可复用成果

|成果|当前证据|能证明什么|不能证明什么|
|---|---|---|---|
|Stage A 契约、Provider、Guard、授权复查、预算和增量状态|`src/lib/algorithms/classification/stage-a-*.ts`|核心算法接口和安全失败路径可运行|真实家庭准确率、生产可用性|
|图片、用户文字、final ASR ingestion 与批次绑定|`ingestion-contract.ts`、`ingestion-organization-adapter.ts`|三类输入能独立保存并进入组织链|真实 Stage A 页面接线已经完成|
|内容组织、故事候选、检索候选和用户动作|`content-organization.ts`、`lab-actions.ts`|本地候选组织与可逆动作已实现|阈值已经校准、长期 Memory 已接入|
|本地 `/classification-lab`|`src/app/classification-lab/`、`src/app/api/classification-lab/`|确定性 Provider 的上传、展示与动作链可运行|真实模型 Provider 已进入页面|
|合成 v3.1 冻结包报告|报告记录 40 groups：26 exploration / 14 validation；原 `/private/tmp` 冻结目录当前已不存在|Git 内报告可证明当时完成过结构审计|当前不能仅凭报告重新执行旧包或复核原始文件|
|2026-09-29 真实模型探索|6/6 个真实请求，2 succeeded、2 needs_review、2 failed|真实 Provider、模型返回、费用记账和 Guard 能协作|不能直接计算准确率，不能代表产品效果|
|`.12` 离线精确重放报告|报告记录 g001、g025 保存响应 2/2 被接住；原 replay 目录当前已不存在|保留当时执行结论和提交记录|当前不能重新读取旧原始响应，也不能把报告替代原始证据|
|E1 语义冻结|`sgx-scoring-policy.2`、`sgx-truth.2.v3-derived-e1-2026-09-29`、盲审 ledger、freeze manifest、正反 fixtures|合成输入的语义合同、时间角色、七类评分口径和安全边界已冻结，可进入 E2|可执行 scorer、历史 r5 exact rescore、真实分布效果或产品效果|
|工程回归|E1 聚焦 6/6；最新受控 loopback 全量分类回归 284/284|E1 Schema、绑定、语义不变量与当前分类工程回归通过|不等于算法效果和产品验收；此前一次 409 / CLI timeout 未复现，作为历史间歇性问题保留|

E0 检查点在受限沙箱运行时，`typecheck` 与 secret scan 通过；当时 `test:classification` 为 250 pass / 28 fail，28 项均因环境禁止监听 `127.0.0.1` 而出现 `listen EPERM`。E1 改动后在允许 loopback 的受控环境完成最新全量复跑，结果为 284/284 通过、0 fail、0 cancelled。更早一次受控运行中的 expired-cache 409 与随后 CLI shutdown 超时未复现，保留为历史间歇性问题，不作为当前 E1 blocker。

E1 聚焦验证 `node --test harness/classification/semantic-scoring-v2.test.mjs` 为 6/6，通过 scoring policy、truth、scoring cases 三份 strict Schema、policy/盲审 ledger hash 绑定、七类语义 fixture、固定分母状态、g025 `role_unknown` 防升级和 freeze manifest 哈希检查。本阶段没有网络或真实 API 调用，没有读取凭据，新增费用为 ¥0；这项验证只支持 `synthetic_functional_only` claim。

## 4. P0：本地真实模型 `T1-Local Product Alpha` 的阻断问题

### P0-01：E1 已冻结 truth 与评分语义，E2 scorer 尚未实现

- **E1 前现象**：g007 的 `聚会`、`桌面` 和 g023 的 `自然景观` 有证据支持，但旧 truth 会把它们当成错误或额外标签；g007 的 `capture` 则另有定义冲突，不能先算作可接受变体。
- **历史根因**：旧评分更接近“精确标签集合对比”，没有系统区分核心标签、可接受变体、有证据的附加标签和无依据的危险断言。
- **E1 处理**：新 revision `sgx-truth.2.v3-derived-e1-2026-09-29` 与 `sgx-scoring-policy.2` 已冻结 `required_core`、`acceptable_variant`、`supported_extra`、`missing_required`、`unsupported_extra`、`unsafe_false_positive` 和 `conflict_incomplete` 七类语义。`supported_extra` 必须由盲审真值或运行前允许列表预先定义，不能由模型自己的输出循环证明。
- **剩余影响**：E2 尚未把冻结 policy/truth 接入可执行 scorer；当前不能据 fixture 存在声称已经完成 r5 评分或功能 Gate。
- **E2 完成标准**：scorer 数据驱动、无 `groupId` 特判，固定分母报告能复现七类结果，并通过相关回归。

### P0-02：E1 已冻结冲突约束，E2 尚未执行计分

- **E1 前现象**：历史 6 次调用中，g011 只有时间矛盾却多报 event conflict；g025 输出声明 time conflict、只保留 1998，并漏掉图片中可见的 2001。
- **历史根因**：模型可以输出冲突名称，但旧评分没有单独核验冲突是否来自同一维度、是否保留双方候选、双方是否都有 Evidence。
- **E1 处理**：冲突不得跨维度传播，且必须有同维度双侧候选和来源。g011 冻结为 2008/2010 的 `event` 时间冲突；g025 的 `2001-07` 缺少 EXIF 或流程 provenance，冻结为 `role_unknown` 观察，不与用户说明的 `event:1998-summer` 组成可评分冲突，工作流进入时间角色澄清。
- **历史边界**：新 truth revision 不会改写 g025 原始 `UNSUPPORTED_TIME_PRECISION`、漏 OCR 或其他失败记录，也不能在缺少原始 r5 响应时做 exact rescore。
- **E2 完成标准**：scorer 能识别 g011 完整冲突、跨维度传播和单侧冲突；`role_unknown` 不得被静默升级成 `event/capture/scan/upload`。

### P0-03：`.12` 只有离线重放，没有新的真实模型样本

- **现象**：g001、g025 的旧响应已在 `.12` 下离线通过，但 `.12` 没有收到新的真实 API 响应。
- **根因**：两项 Guard 修复发生在 6 次批准调用完成之后，当前批准请求数已经用完。
- **影响**：可以证明兼容旧响应，不能证明新请求在 `.12` Prompt/Guard 下仍有相同输出分布。
- **处理**：先完成全部离线 Gate；随后用页面真实冒烟中的第一个互补场景验证 `.12`，失败立即停止，0 自动重试。
- **完成标准**：新响应记录模型、Prompt、token、费用、时延和稳定状态，且不泄漏凭据。

### P0-04：`/classification-lab` 仍只有 deterministic Provider

- **现象**：`LabProviderMode` 只有 `deterministic`；`createConfiguredLabProvider` 对其他模式抛出 `REAL_PROVIDER_ADAPTER_NOT_CONFIGURED`。
- **根因**：CLI Stage A 和产品实验台分别完成，但缺少将 Ingestion/Evidence 转换为 `TrustedStageACatalog` 并驱动 `ClassificationEngine` 的正式 adapter。
- **影响**：用户在页面上传真实或合成照片时，看到的仍是确定性演示结果，不是真实模型结果。
- **处理**：新增 `stage_a_mock` 与 `stage_a_real`，复用现有 `ApiVisionProvider`、`adaptTrustedStageACatalog`、`ClassificationEngine` 和 `adaptStageAForOrganization`。
- **完成标准**：deterministic 可回退；mock 可完整走页面；旧保存响应只有按 hash 恢复后才能追加 replay；真实模式只能在服务端启用。

### P0-05：Lab 存储 Schema 明确拒收真实 Provider 结果

- **现象**：`lab-store.ts` 只接受 `provider.mode === deterministic` 且 `accuracyClaim === not_evaluated`。
- **根因**：存储结构最初只为本地 deterministic 基线设计，没有为 Stage A 结果、usage、错误和审计字段定义严格联合 Schema。
- **影响**：即使 Provider adapter 可以运行，结果也无法安全持久化和重新读取。
- **处理**：建立按模式区分的严格 result schema；保存模型版本、Prompt 版本、Evidence audit、请求数、token、费用和时延；不得简单删除校验。
- **完成标准**：非法模式或缺失审计字段仍拒收，三种合法模式都可稳定读取。

### P0-06：Lab 指标目前固定写成 0

- **现象**：`lab-service.ts` 成功后固定写入 `modelRequests: 0, costCny: 0`。
- **根因**：当前唯一 Provider 不调用模型，service 尚未消费 Stage A usage。
- **影响**：真实模式下会把实际调用显示成零成本、零请求，破坏预算审计。
- **处理**：Provider result 返回受 Schema 约束的 usage；service 只从受信结果汇总，不由浏览器传入。
- **完成标准**：mock 为 0；保存响应 replay 明确为 0 外部调用；真实模式记录实际值和保守账本边界。

### P0-07：批次级文字/ASR 与 Stage A 单图输入的边界尚未接好

- **现象**：Lab ingestion 支持 `batch` 或多图目标；`adaptTrustedStageACatalog` 则要求进入 Stage A 的每条文字 Evidence 恰好绑定到一张图片，未绑定文字会触发 `UNBOUND_TEXT_EVIDENCE`。
- **根因**：这是两层契约的职责差异：Stage A 做单图观察，内容组织层可以处理批次级说明；真实 Lab adapter 还没有把两类 Evidence 分流。
- **影响**：若直接把全部 Evidence 塞进 Stage A，会拒绝合法批次输入；若复制到每张图，会把候选关系伪造成单图事实。
- **处理**：只把明确单图绑定的文字送入该图 Stage A；批次或多图说明保留独立 Evidence，由关联/组织层提出候选。
- **完成标准**：单图绑定、多图绑定、未指定图片、纯文字、纯 final ASR 都有测试，且不会擅自改写 Evidence 归属。

### P0-08：真实 Stage A 结果尚未经过 Lab 用户动作生命周期

- **现象**：接受故事、拒绝关联、移出、拆分、合并、删除 Evidence 和撤回授权已在 deterministic 结果上实现，但未用 Stage A 结果验证。
- **根因**：真实 Lab Provider 尚未接入，动作层没有真实观察、冲突和 Stage A 关联作为输入。
- **影响**：可能出现动作后故事未重算、撤权后旧候选仍显示、删除后支持证据残留等集成错误。
- **处理**：先用 mock 逐项执行全部动作；旧保存响应只有按 hash 恢复后才追加 replay；随后做真实模型页面冒烟。
- **完成标准**：删除或撤权后旧结果不能继续用于展示、候选搜索或后续组织；操作保持幂等和 stale-write 防护。

### P0-09：页面真实模式尚无独立的预算与授权预检

- **现象**：CLI 已有 manifest、approval、expiry、maxRequests、maxCost 和输出目录保护；页面 Lab 尚未拥有同等级的运行清单。
- **根因**：Lab 目前没有外部请求，因此没有实现真实模式的 request reservation 和审批绑定。
- **影响**：一次多图上传可能产生超过预期的 extract/relate 请求，无法在调用前给出精确上限。
- **处理**：真实页面运行前离线计算最坏请求数、图片数、token/费用上限和停止条件；绑定素材 hash、模型和 Prompt 版本。
- **完成标准**：缺授权、过期、素材变化、模型变化或预算不足均在首个外部调用前停止。

### P0-10：E1 已统一 `capture`、`event` 与 `role_unknown`，下游实现待消费

- **E1 前现象**：现行 `.12` Prompt 规定 `capture` 只能来自可信原始 EXIF，用户说明“照片拍于某日”应归为 `event`；真实模型报告和旧执行计划却曾把 g007 的 ASR 解释为 `capture` 更合理。
- **历史根因**：Prompt 将 `capture` 定义为传感器/原始文件时间，报告把它解释成自然语言中的“拍摄语义”。
- **E1 处理**：冻结 policy 保持 EXIF-only `capture`；用户文字或 final ASR 描述某次活动中的拍摄日期记为 `event`；没有 provenance 的图片像素日期保留为 `role_unknown`。g007 的 `capture` 不再是可接受答案，g025 的 `2001-07` 不再自动制造时间冲突。
- **剩余影响**：E2 scorer 和 E3 内容组织必须消费结构化 role/precision，不能只比较时间字符串。若未来产品改变“用户明确声明拍摄日期”的解释，必须同时版本化 Prompt、Guard、truth、policy 和测试。
- **完成标准**：scorer、组织链和权威文档都遵守冻结角色；`role_unknown` 只能经有 provenance 的后续确认升级。

### P0-11：旧冻结包与真实响应只放在 `/private/tmp`，当前已经不可访问

- **现象**：2026-09-29 文档引用的 r5 冻结目录、两个真实运行目录和 `.12` exact replay 目录当前均不存在；在常用持久目录也未找到同名副本。
- **根因**：实验以系统临时目录作为长期证据源，没有在完成后复制 manifest、hash ledger、脱敏原始响应、metrics 和 provenance 到受控持久目录。
- **影响**：原计划中的“6 例离线重算”和“保存真实响应页面 replay”当前不能复现；Git 报告只能证明当时记录过结果，不能替代原始产物。
- **处理**：保留 Git 报告与历史提交，不伪造旧原始响应；用源数据重建新的版本化合成冻结包；下一次真实调用先确定持久输出根和 digest，再执行。若找到旧原始目录，只能按 hash 核对后归档，不能覆盖历史报告。
- **完成标准**：新批次的 manifest、truth/scorer、approval reference、ledger、metrics、脱敏响应和报告有持久路径与不可变 digest；临时工作目录不再是唯一证据。

### P0-12：Lab 幂等键没有包含 Provider、模型、Prompt 和 scorer 版本

- **现象**：`jobId/idempotencyKey` 只由输入内容和 scope 生成。相同输入先跑 deterministic，再切到 `stage_a_real` 时会直接返回旧任务，不会调用新 Provider。
- **根因**：Lab 最初只有一种 Provider，执行配置没有进入 run identity。
- **影响**：页面可能把旧 deterministic 结果误显示为真实模型结果；Prompt 升级后也可能命中旧缓存。
- **处理**：把数据身份和运行身份分开：`contentDigest` 表示相同输入，`runId/idempotencyKey` 额外绑定 provider、model、prompt、taxonomy、scorer、authorization revision 和目的；同配置重放幂等，不同配置产生新 run。
- **完成标准**：同输入同配置只执行一次；任何影响结果的版本变化都产生新 run，同时仍能追溯到同一 content digest。

### P0-13：同步 POST 无法真正实现运行中取消、撤权和晚到结果拒收

- **现象**：POST 在 `provider.run` 完成后才返回 job；`ClassificationLabProvider.run` 没有 `AbortSignal`。客户端拿到 jobId 前无法发出撤权或取消。
- **根因**：deterministic Provider 很快，初版采用单请求同步流程；真实模型引入长时运行后，生命周期边界没有随之调整。
- **影响**：计划中要求的 in-flight cancel、撤权中止和晚到结果拒收无法在页面链真实验证。
- **处理**：改为两阶段：先创建并返回 pending job，再由受控本地 runner 启动；维护 abort registry 或可替换 runner 接口；Provider 接收 `AbortSignal`，落盘前再次校验授权、版本和 generation token。
- **完成标准**：运行中取消会传到 Provider；取消/撤权后的晚到结果不能覆盖 cancelled 状态或重新进入组织链。

### P0-14：Lab 接受的图片大小与真实 Provider 上限不一致

- **现象**：Lab 允许单图 20 MiB、批次 100 MiB；Stage A 真实 Provider 当前拒绝大于 1 MiB 的单图。Lab 尚未生成带 provenance 的派生图。
- **根因**：页面上传限制按本地存储设计，模型请求限制按 API 成本与稳定性设计，两层没有共享媒体预处理契约。
- **影响**：常见手机照片可能通过页面校验后在真实模型阶段失败；简单把上限降到 1 MiB 又会损失原图留存需求。
- **处理**：保留原图 Evidence；服务端生成受控 sRGB/JPEG/WebP 派生图用于模型，记录原图 hash、派生图 hash、尺寸、变换参数和授权继承。T0 若尚未实现派生图，页面需在提交前明确限制并给出稳定错误码。
- **完成标准**：模型只读取已授权派生图；原图与派生图可追溯；页面不会接受后再以未知错误失败。

### P0-15：时间 role 与 precision 在 Stage A→内容组织时丢失

- **现象**：Stage A observation 有 `event/capture/scan/upload` 与 precision；当前组织 adapter 主要传递时间值，组织器按 normalized value 比较。
- **根因**：早期内容组织模型把时间当作扁平标签，没有保留结构化语义。
- **影响**：同一年中的事件时间、翻拍时间和上传时间可能被错误视作同类聚类信号，老照片尤其容易被按扫描/上传时间归组。
- **处理**：组织 Observation 保留 `value + role + precision`；故事分组优先 event，capture 仅作拍摄时间，scan/upload 默认作为管理元数据而非人生事件时间。
- **完成标准**：同值不同 role 的正反测试通过；标题、时间线和分组明确采用哪一种时间。

### P0-16：Stage A 与 Lab 之间仍有状态和 ID 映射缺口

- **现象**：Stage A 使用 Evidence ID 作为 photoId，内容组织使用 contentId；`batchBindings` 虽从 adapter 返回，但尚未证明被真实组织器消费；若每个 Lab 请求新建内存 engine，旧 snapshot 也不会自然跨请求保存。
- **根因**：Stage A CLI、Ingestion、Lab 和组织器各自完成了局部契约，尚未由一个 composition adapter 冻结 ID 映射和状态存储职责。
- **影响**：可能重复生成图片内容项、丢掉批次关联、无法做增量更新，或让撤权/修正只作用于某一层 ID。
- **处理**：E3a 明确 `evidenceId ↔ contentId ↔ photoId` 映射表和唯一主键；E3b 把 snapshot store 作为可替换依赖注入 runner；组织器显式消费 batch/multi-image bindings。
- **完成标准**：单图、多图、批次说明、增量修正、删除和撤权在三类 ID 之间均有可追溯测试，不出现重复 ContentItem。

## 5. P1：冻结 T1 与全栈交付前的问题

### P1-01：`0.80/0.55` 未经过数据校准

- **现象**：内容组织规则仍保留高/中分段基线，但 policy 标注为 `shadow`、`calibrated=false`。
- **根因**：当前分数是检索与组织启发式，不是模型概率，也没有真实 validation 的风险—收益曲线。
- **影响**：若直接用于产品自动化，会造成过多确认或错误自动归纳。
- **处理**：T0 采用“低影响、可撤销内容可自动整理；身份、关系、敏感事实和长期 Memory 独立确认”的影响分级；T1 收集分层命中和人工动作，不把阈值写成准确率。
- **完成标准**：每个自动动作能解释触发规则、Evidence 和可撤销路径；正式数值阈值在冻结 validation 后另行校准。

### P1-02：模型仍有 OCR/语义召回和冲突表达缺口

- **现象**：历史 6 次调用中，g025 漏掉图片中的 2001；g011 多报 event conflict。E1 input-only 盲审已把可见的 `2001-07` 作为 `role_unknown` 观察写入新 truth，但这不代表模型 OCR 已修复。
- **根因**：Flash 模型对小字 OCR、冲突对齐和受控 taxonomy 的输出并不稳定，单次 Prompt 无法消除所有语义错误。
- **影响**：部分内容会漏归类或进入不必要复核。
- **处理**：保留拒判和局部失败；未来混合链用本地 OCR 提供候选文本，Flash 处理困难语义与摘要；评分分别统计漏掉、误加和危险误报。
- **完成标准**：T1 中高风险无依据断言为 0，普通召回缺口可被明确量化和人工修正。

### P1-03：混合部署目前主要停留在设计层

- **现象**：已有 exact retrieval 与 VLM Stage A；尚无正式 OCR、embedding、近重复检测和授权后人物聚类 adapter 接入 Lab。
- **根因**：当前阶段优先打通契约与 VLM 主链，尚未选型、许可审查并集成本地视觉/向量组件。
- **影响**：仅靠 VLM 处理大批照片时成本和时延会增加，跨时间的相似检索和近重复能力不足。
- **处理**：先完成真实 Stage A 的 `T1-Local Product Alpha`，再按开源优先原则评估并接入 OCR、embedding 和 near-duplicate；VLM 只处理困难语义、冲突和摘要。
- **完成标准**：每个新增模块有 URL、license、复用范围、接口和回退方式；不能把未集成项目写成已有能力。

### P1-04：尚无多图真实页面的成本和性能证据

- **现象**：最新 6 次探索是 6 张图的单图 extract；累计模型延迟 46.377 秒，尚无页面端到端、批次、多图关联或 p95 数据。
- **根因**：真实 Lab adapter 未完成，无法测上传、预处理、模型、关系、组织和渲染全链。
- **影响**：无法回答一次 10–20 张上传的真实等待时间、请求数和成本。
- **处理**：E4 先做 1 图和 2 图互补冒烟；E5 记录每阶段时延；更大批次等本地预筛和候选召回接入后测试。
- **完成标准**：至少报告端到端时延、模型请求数、图片数、token、费用和失败阶段，不能只给总耗时。

### P1-05：14 组 `t1_validation` 尚未执行

- **现象**：40 组合成数据中的 26 组是 exploration，14 组 validation 仍未进行冻结真实模型验收。
- **根因**：E1 已冻结 truth/scoring policy，但 E2 可执行 scorer、离线 Gate 和新的付费授权尚未完成。
- **影响**：不能给出固定分母的功能验收结论。
- **处理**：Gate 2 冻结后一次性运行，0 自动重试，failed/not_run 保留在分母；不在 validation 上继续调参。
- **完成标准**：14/14 均有最终状态和原始证据，hard Gate 失败则停止并创建新版本，而不是覆盖重跑。

### P1-06：真实世界效果分母仍为 0

- **现象**：当前素材是高真实感 AI 合成，模型调用是真实的，但没有真实家庭照片、真实用户文字或真实录音。
- **根因**：尚未获得可授权、可审阅、可留存的真实家庭数据。
- **影响**：可以验证功能完整性、契约和多场景行为，不能宣称真实家庭准确率、跨家庭泛化或用户收益。
- **处理**：按用户当前目标先完成合成功能 T0/T1；后续真实试用单独建立数据授权、truth 和效果报告。
- **完成标准**：所有报告始终分开 synthetic 功能证据、真实模型工程证据、真实家庭效果和生产能力。

### P1-07：C036 与 C027 仍是已知效果边界

- **现象**：C036 的模糊质量标签曾漏标；C027 的纯照片不足以证明文件来源是 screenshot。
- **根因**：质量维度尚未纳入当前五维主 Gate；screenshot 是来源/文件语义，不能只凭画面可靠断言。
- **影响**：如果把它们混入五维准确率，会制造错误结论。
- **处理**：C036 作为后续 quality 扩展用例；C027 在缺少文件元数据时必须拒判或标为候选。
- **完成标准**：不再使用 Fake 固定输出声称这两个问题已解决。

### P1-08：人物稳定参考与渐进自动归纳尚未产品化

- **现象**：用户已经决定“首次确认建立临时参考，累计 2–3 张跨年代/角度/质量照片后成为稳定参考”，当前真实测试关闭人物匹配。
- **根因**：缺少明确授权后的 reference store、质量门禁、撤回传播和 UI 确认链。
- **影响**：当前可以形成“人物 A/B”候选组，但不能实现确认一次后的稳定自动归纳。
- **处理**：本轮保持不做人脸身份匹配；作为 T2 前的独立设计与数据门禁任务，不与五维 Stage A 首链混跑。
- **完成标准**：只有授权、稳定参考和高确定匹配同时满足时才能自动归纳；姓名和亲属关系仍由用户确认。

### P1-09：确认反馈尚未形成长期自适应闭环

- **现象**：已有 correction、reference 和 append-only action 结构，但页面确认还没有转成长期可复用的稳定参考、个人词汇或校准统计。
- **根因**：算法状态与产品长期存储尚未通过正式 adapter 连接。
- **影响**：系统不能充分实现“随着用户使用，确认次数逐渐减少”的产品目标。
- **处理**：全栈交接时定义确认事件、证据引用、版本和撤回传播；算法侧只消费被授权的稳定状态。
- **完成标准**：确认一次不会直接变成不可撤销事实；后续自动化有来源、版本、适用范围和回滚路径。

### P1-10：长期 Memory 和访谈算法只有边界，没有正式写入 adapter

- **现象**：候选可以支持搜索与访谈问题生成，但当前没有从确认事实到长期 Memory 的正式 adapter。
- **根因**：分类窗口有意禁止算法直接写业务数据库或把模型候选升级为长期事实。
- **影响**：这保护了安全边界，但尚未形成下游产品闭环。
- **处理**：T2 定义 `candidate → confirmed/edited → MemoryCandidate → long-term Memory` 的独立服务与权限；撤回必须向下游传播。
- **完成标准**：未经确认的身份、关系和人生事实不能进入长期 Memory；低风险 AI 标题和摘要可以保留候选状态。

### P1-11：PRD traceability 文件落后于当前实现

- **现象**：`harness/classification/prd-traceability.json` 仍以早期“task_one_first_batch_synthetic_contract”为范围，测试列表和 gap 没有覆盖 Stage A、Lab、混合检索与 2026-09-29 真实模型证据。
- **根因**：功能持续迭代，但机器可读追溯文件没有在每一阶段同步扩展。
- **影响**：全栈工程师可能依据旧文件误判已完成范围与缺口。
- **处理**：E6 前更新 feature、tests、gap 和 readiness，同时引用用户在当前对话覆盖 PRD 的产品决定。
- **完成标准**：追溯文件、状态文档、完整指南和交接文档对同一能力使用相同状态。

### P1-12：T1 Gate 只有安全与完整性约束，可能让“全部拒判”通过

- **现象**：E1 已冻结安全 Gate、固定分母和功能报告字段，但功能 Gate 的具体数值阈值按设计仍为 `pending_real_data_calibration`；当前 E5 还没有 required core 最低覆盖、有效拒判或场景 invariant 的冻结数值。
- **根因**：为了避免拍脑袋设置准确率，计划暂时只写了安全 Gate，却遗漏了产品可用性下限。
- **影响**：一个对 14 组全部输出 `no_assertion/needs_review` 的系统可能通过安全 Gate，但不具备自动分类和归纳价值。
- **处理**：E2 先按 E1 policy 输出 required-core、拒判、故事成组/拆分 invariant 和各场景结果；具体数值只能在 exploration 与本地产品链上校准，并在查看 validation 前冻结成新版本。
- **完成标准**：validation 运行前已有带版本和 hash 的功能门槛；全拒判不能通过。

### P1-13：权威文档和图存在版本漂移

- **现象**：本轮审计前，全栈 handoff 仍写 Prompt `.6` 和 168 项测试，execution index 也容易被理解为 E1–E3 已完成；这两处已随本报告修正。仍未完成的是：两张主要流程图源码写 `.10`，嵌入 PNG 早于最新源码，历史状态正文仍含过时下一步，机器可读 traceability 仍停在早期范围。
- **根因**：代码、实验、图和交接文档分别演进，没有统一的当前状态表和版本检查。
- **影响**：用户或全栈工程师可能按旧 Prompt、旧测试数或旧任务执行，造成假完成或重复工作。
- **处理**：E6 前统一 `.12`、当前测试命令、证据 lane 和状态；测试操作说明不固定写死数量；历史快照明确归档；重新导出与源码一致的流程图。
- **完成标准**：完整指南、handoff、状态、图、execution index 和 traceability 对关键版本与 readiness 无矛盾。

### P1-14：历史真实请求累计数量口径不统一

- **现象**：历史状态、R3–R10 报告和最新报告使用了不同“累计调用”口径；当前可以确认本轮 6 次，但不能在未核对 ledger 前安全给出整个项目总数。
- **根因**：旧分类链、Stage A Qwen 3.7 不同批次和不同模型共用“项目累计”名称。
- **影响**：成本审计、批准余量和结果解释可能混淆。
- **处理**：建立不可变调用账本，按 pipeline、model、batch、request、image、usage、cost 和 authorization 分栏；文档先报告本轮确定数字，不再推算历史总数。
- **完成标准**：任何累计值都可由 ledger 行求和并定位到运行目录和授权记录。

### P1-15：真实批次的非致命错误仍会停止后续项

- **现象**：`real_api` 模式下某个 extract/relate 出现 `INVALID_OUTPUT` 等错误后，pipeline 会停止后续真实调用。
- **根因**：该行为最初用于控制付费预算和避免连续脏输出，现在与“单资产失败隔离、继续独立项”的产品目标存在张力。
- **影响**：一张坏图可能让同批其余照片停在 `not_run`，降低批量整理可用性。
- **处理**：授权、预算、deadline、模型版本、取消和来源变化继续作为全批 fatal；独立照片的可隔离语义/输出错误留档后可继续，但必须受总请求上限约束且 0 自动重试。
- **完成标准**：fatal 与 isolatable 错误有冻结表；测试证明失败项保留在分母、其他独立项仍可完成。

### P1-16：Lab 输入模型不足以表达真实多段内容和权利主体

- **现象**：当前页面只有一个 `userText` 和一个 `finalAsr`；上传图的 `ownerId` 默认写成 `subjectId`。
- **根因**：初版实验台用最小表单验证链路，没有采用 Evidence item 列表，也没有让相册上传与家庭互传分别提供 owner/contributor 策略。
- **影响**：多段说明、多段语音、多贡献者场景无法完整模拟；子女上传时可能错误假设素材权利主体是老人。
- **处理**：改为多条 Evidence 输入，每条带来源、owner、contributor、binding 和 consent；默认值只能是明确的产品策略，不能从 subject 静默推断。
- **完成标准**：至少覆盖两段文字、两段 final ASR、两位贡献者和批次/多图/单图绑定。

### P1-17：页面没有可信 EXIF 解析，真实文本仍是启发式路径

- **现象**：Lab 上传没有服务端解析可信 `capturedAt`；纯文字/final ASR 使用 deterministic text extractor，真实 Stage A 是 image-centric。
- **根因**：当前优先完成视觉契约与本地实验页，EXIF ingestion 和真实文本 Provider 尚未接入。
- **影响**：`capture` 主链无法用真实上传验证；即使图片调用 Qwen，也不能把整条图文链描述为“所有模态均由真实模型理解”。
- **处理**：E3 增加 EXIF provenance；明确“真实视觉 + 规则文本”的当前组合。若 T1 要验证开放文本理解，再增加独立 text Provider，不用空图片绕过接口。
- **完成标准**：报告逐模态标明 Provider；原事件时间和扫描/上传时间不混用。

### P1-18：当前五维与标题摘要仍是首版能力，不是完整终态

- **现象**：真实 Stage A 主要覆盖 person/time/place/event/scene；theme、quality、duplicate、screenshot 等未全部进入真实链；标题摘要仍有模板式组织成分。
- **根因**：项目按首链最小闭环推进，尚未把后续扩展维度与生成式摘要全部产品化。
- **影响**：可以验首版智能相册功能，不能宣称所有未来分类维度和成品文案质量已经完成。
- **处理**：T0/T1 明确五维首链范围；quality、重复、来源类型和主题扩展采用版本化 taxonomy，不在当前 Gate 中偷换分母。
- **完成标准**：每个新增维度有独立 Evidence、truth、拒判和回归，不影响历史版本读取。

### P1-19：本地候选扫描和真实调用仍缺少大库性能方案

- **现象**：当前 exact retrieval 会在本地遍历内容对后再选 top-K；真实 extract 按照片串行。系统并没有把所有照片对都发送给大模型，但本地 O(N²) 和串行调用仍会随图库增长放大。
- **根因**：T0 规模优先验证正确性，OCR、pHash、embedding、ANN、批处理与并发尚未正式集成。
- **影响**：小批次可以运行，大图库的时延与资源不可接受。
- **处理**：H2/T2 采用 pHash/近重复、OCR、embedding/ANN 先召回 top-K，再调用 VLM 处理困难候选；缓存按内容 hash 和算法版本失效。
- **完成标准**：报告候选数、比较数、VLM 调用数、缓存命中和端到端时延；不把本地 pair 扫描误写成 token 成本。

### P1-20：真实请求的采样参数与开源采用清单尚未完全冻结

- **现象**：Provider 固定了 response format、max tokens、stream/thinking 等参数，但未明确记录 temperature/top-p；开源调研已有 SigLIP2、PaddleOCR、OpenCLIP、FAISS/HNSWlib、Immich、LibrePhotos、InsightFace 等候选，却没有完成 exact checkpoint、license/notice、离线 benchmark 和最终采用边界。
- **根因**：模型契约与候选调研先完成，复现性参数和 Source Gate 交付尚未收尾。
- **影响**：模型默认参数变化会影响重放稳定性；开源候选不能直接等同已集成能力。
- **处理**：核对供应商对采样参数的实际支持后显式冻结并记入 ledger；每个采用模块记录仓库 URL、license、checkpoint、复制/改造范围、benchmark 和回退方式。
- **完成标准**：真实 run manifest 能完整解释生成参数；正式接入的开源组件都有 license manifest。

## 6. P2：生产 T2 的明确边界

这些不是当前算法 T0/T1 的失败，但必须在交给全栈后实现：

|ID|问题|根因|T2 责任与验收|
|---|---|---|---|
|P2-01|没有生产数据库、ORM 和事务|本地 Lab 使用文件存储|全栈实现业务记录、版本、并发和迁移；算法只经契约读写|
|P2-02|没有 Redis、持久队列和 worker|Lab 在 HTTP 请求内同步运行|全栈实现异步 Job、重试策略、取消、超时、幂等与死信；默认不自动重试付费模型|
|P2-03|没有正式对象存储和签名访问|图片保存在本机 Lab 目录|全栈实现加密对象存储、短期授权读取、hash 校验和访问审计|
|P2-04|没有生产账号鉴权与家庭 ACL|Lab 只允许本机实验访问|全栈验证 actor、subject、owner、contributor、代理权限和跨家庭隔离|
|P2-05|删除动作不等于生产物理删除|本地动作会隐藏 asset ref，但二进制清理不属于当前实验实现|全栈实现 tombstone、下游撤回、缓存失效、最终物理删除和证明|
|P2-06|没有生产监控、告警和成本聚合|当前证据来自本地结果目录|全栈按稳定错误码统计成功、拒判、复核、延迟、费用、撤权和删除传播|
|P2-07|没有正式发布、灰度和回滚机制|当前分支仅本地开发|全栈以 Provider 开关和版本化契约灰度，保留 deterministic/mock 回退|

## 7. 已修复但必须保留记录的问题

|历史问题|原始原因|当前控制|仍需注意|
|---|---|---|---|
|`APPROVAL_EXPIRED`|approval 到期后继续使用旧授权|执行前校验 expiry 和 manifest hash|新的付费批次必须重新生成精确批准文件|
|Node `EEXIST` 堆栈|已有结果目录被重复使用|CLI 返回稳定 `OUTPUT_DIRECTORY_EXISTS`|旧证据目录不删除、不覆盖；新轮次用新目录|
|`STAGE_A_EXIT_*` 难以理解|外层包装器把受控停止显示为异常堆栈|包装器转发稳定退出，报告首个业务错误码|排查应先看 `REPORT.md` 和 `errors[].diagnostic`|
|多轮 `INVALID_OUTPUT`|模型 JSON 与严格 Schema/语义不一致|安全诊断、Prompt/Guard 版本化、失败即停|严格拒收是保护，不能为了“跑通”放宽到接受脏字段|
|g001 `INVALID_TIME`|`YYYY-MM` 与 `precision=year` 未保守降级|`.11` 机械归一化并有回归测试|原始真实失败仍保留，不能改写历史|
|g025 两位年份无法校验|“九八年”不能支撑四位年份|`.12` 冻结世纪分界并有回归测试；E1 新 truth 将可见 `2001-07` 保留为 `role_unknown`|历史 OCR 漏召回和 `UNSUPPORTED_TIME_PRECISION` 仍保留；新 truth 不等于模型问题已修复|
|普通沙箱 HTTP `EPERM`|运行环境禁止本地监听|在受控 loopback 环境重跑|不能把环境限制误诊成业务逻辑失败|

## 8. 下一阶段执行计划

### E0：建立持久证据登记和新批次输出规范

**当前状态（2026-09-29）**：registry strict Schema、离线 writer/verifier、CLI、运行目录边界、旧临时产物 missing ledger 和聚焦回归已经实现。Stage A 自动 finalization 尚未接线；在接线完成前，真实执行清单必须显式执行 create + verify，不能回退到 `/private/tmp`。

**产物**：artifact registry Schema、受控持久输出根约定、旧 `/private/tmp` 产物缺失记录、新批次目录模板。
**处理原则**：旧 raw response 找不到就保留 blocker，不能重造；可从原始源数据生成新的冻结版本，但必须使用新 revision/digest。
**Gate**：registry 记录 dataset、manifest、truth/scorer、model、prompt、approval、ledger、metrics、provenance、绝对路径和 SHA-256；任何敏感正文不进入 Git。
**提交边界**：`docs(evaluation): define durable artifact registry`。

### E1：冻结语义与评分规则（已完成）

**当前状态（2026-09-29）**：已冻结 `sgx-scoring-policy.2.2026-09-29` 与新 truth revision `sgx-truth.2.v3-derived-e1-2026-09-29`，并生成 scoring policy、truth、scoring cases 三份 strict Schema、正反 fixtures、四例 input-only 盲审 ledger 和逐文件 SHA-256 freeze manifest。聚焦测试 6/6、受控 loopback 全量分类回归 284/284 通过；没有网络或 API 调用、没有读取凭据、额外费用 ¥0。

**g025 裁决**：用户说明支持 `event:1998-summer`；图片像素的 `2001-07` 缺少 EXIF/流程 provenance，只作为 `role_unknown` 观察并进入角色澄清，不形成同角色冲突。该裁决属于新的 v3-derived truth，不修改历史 r5 truth、报告、原始 6 次调用状态或失败记录。

**证据边界**：E1 只支持 `synthetic_functional_only` claim。旧 r5 与 6 次调用的 raw response 当前不可访问，不能 exact rescore；E1 也没有实现可执行 scorer 或完成合成功能 Gate。

**Gate 结果**：规则可泛化、无样例特判、`supported_extra` 不循环定义、人物/敏感事实/Memory 边界不变，可进入 E2。

**建议提交边界**：`docs(classification): freeze semantic scoring v2`；当前记录不表示已经提交。

### E2：实现版本化 scorer v2

**产物**：读取 E1 冻结 `sgx-truth.2 + sgx-scoring-policy.2` 的评分实现、测试和可复现 fixtures 评分报告。旧真实响应当前缺失，不伪造“6 例离线重算”；若原始产物后续按 hash 恢复，再追加独立复算报告。
**主要文件**：`stage-a-evaluation.mjs`、`stage-a-eval.test.mjs`、`synthetic-v3-adapter.ts` 及测试；只有源真值或冻结政策确实变化时才修改 `prepare-synthetic-v31.mjs`。
**Gate**：旧 r5 完全不覆盖；failed/not_run 留在分母；分类回归、typecheck、secret scan、diff check 通过。
**提交边界**：测试与实现分成两个小提交。

### E3：接入 Stage A Lab Provider

分为三个可单独回退的子阶段：

- **E3a composition adapter**：`stage_a_mock`、Evidence/photo/content ID 映射、单图与批次 Evidence 分流、严格 result union；
- **E3b execution lifecycle**：content digest 与 run identity、两阶段 job runner、snapshot store、AbortSignal、取消/撤权/晚到结果 CAS；
- **E3c real provider factory**：真实 Provider、机器可校验执行授权、usage、媒体派生图/EXIF provenance、结构化时间路由和配置说明。

保存真实响应 replay 只有在原始产物按 hash 恢复后执行；当前以明确标注的 mock fixtures 验证离线链。
**主要文件**：`lab-provider.ts`、`lab-store.ts`、`lab-service.ts`，以及聚焦测试。
**Gate**：零网络、零密钥读取、零费用完成成功/拒判/复核/非法输出/限流/超时/运行中取消/撤权/删除/晚到结果测试；同输入在 Provider/模型/Prompt 变化时不会命中旧 run；图片上限在页面与 Provider 间一致；event/capture/scan/upload 不被压平；deterministic 保持可用。
**提交边界**：adapter、边界测试、文档各自小提交。

### E4：本地页面真实模型 `T1-Local Product Alpha` 冒烟

**前置**：E0–E3 全部通过；生成精确素材清单、请求上限、费用上限和停止条件；用户另行批准。
**场景**：单图+文字、两图+批次说明或 final ASR、冲突或图片内提示词。
**动作矩阵**：不同 Job 分别覆盖 accept、reject association、split、merge、remove、delete、cancel 和 revoke；revoke 必须是所属 Job 的最后动作，不能把互相破坏前置条件的动作硬塞进同一 Job。
**Gate**：页面确实走真实 Stage A；所有结果可追溯；动作矩阵通过；预算内；0 自动重试。
**失败策略**：保留失败目录，停止后归因，不覆盖或静默重跑。

### E5：14 组冻结 `T0-Synthetic Functional Gate`

**前置**：`.12`、taxonomy、truth/scorer v2 已冻结；用户批准 exact manifest 和预算。
**Gate**：`unsafe_false_positive=0`；跨家庭、跨主体、撤回、旧授权和提示词注入违规均为 0；14/14 有最终状态。
**约束**：只运行一次，不用 validation 调 Prompt；hard fail 后创建新版本再申请新批次。

### E6：全栈 T2 交接

**产物**：endpoint、字段、Provider 切换、secret 边界、状态机、错误码、T2 adapter 替换点、测试命令和人工验收清单。
**Gate**：更新完整指南、状态、机器可读 PRD traceability、handoff 和执行日志；工作树干净，可按小提交回退。

## 9. 执行顺序与停止条件

```text
问题清单冻结（本文）
  → E0 持久证据 registry（已实现）
  → E1 盲审时间语义/评分 policy/truth（已冻结）
  → E2 scorer v2 + 固定分母报告（下一项）
  → E3 Lab Stage A adapter（零外部调用）
  → 申请 E4 精确授权
  → E4 页面真实模型 T1-Local Product Alpha
  → 申请 E5 精确授权
  → E5 冻结合成功能 Gate
  → E6 全栈交接
```

遇到以下任一情况立即停止相应阶段：

- truth、scorer、Prompt 或 taxonomy 在 validation 前没有冻结；
- 浏览器能够读取凭据或上游原始敏感错误；
- manifest、素材 hash、模型、Prompt 或授权记录发生变化；
- 请求数、token、费用或超时超过已批准上限；
- 首个真实响应出现非法输出、模型版本不符或高风险无依据断言；
- 删除、撤权、跨家庭或旧授权结果仍可被继续使用。

## 10. 角色边界

|角色|当前负责内容|当前不负责内容|
|---|---|---|
|算法/T0/T1 窗口|truth/scorer、Stage A Provider adapter、Guard、内容组织、本地 Lab、冻结评测、证据报告|生产数据库、Redis、队列、账号、部署|
|用户|重大产品规则；E4/E5 付费调用的精确授权|不需要编写 ORM、Redis 或队列代码|
|全栈工程师/T2|生产存储、对象存储、队列、鉴权、API、部署、监控、物理删除|不擅自改变算法契约、风险边界或 Memory 确认规则|

## 11. 当前用户需要配合的事项

现在没有需要用户立即补充或决策的事项。算法窗口可直接推进 E2–E3。只有两个后续节点需要用户批准：

1. E3 离线 Gate 全部通过后，批准 E4 的准确请求数、费用上限、素材和停止条件；
2. E4 通过后，批准 E5 的 14 组固定 manifest、最大请求数和费用上限。

## 12. 阶段完成定义

- **T0-Synthetic Functional Gate 完成**：冻结的 14 组合成 validation 有固定分母的功能与安全结论，且没有用 validation 继续调参。
- **T1-Local Product Alpha 完成**：本地页面能用真实模型处理图片+文字/final ASR，结果经过 Guard 与组织链，动作矩阵和失败恢复可验证，凭据留在服务端。
- **Real Distribution Gate**：需要 30–50 个授权真实内容组及独立真值；当前真实分母为 0，不与上述两项混称，也不阻塞当前合成功能链开发。
- **可交付全栈**：T0/T1 证据、接口、配置、错误码、测试和 T2 替换点齐全，文档状态一致，分支可回退。
- **仍不能宣称**：真实家庭准确率、跨家庭泛化、正式人脸身份识别、长期 Memory 已上线或生产发布完成。

# Classification Lab Stage A Composition Adapter Spec

> 日期：2026-09-29  
> 阶段：E3a  
> 状态：已实现并完成离线集成验证（2026-09-30）
> 前置：E0 artifact registry、E1 semantic policy/truth、E2 `sgx-semantic-scorer.2.0.0`  
> 证据边界：`offline_integration_contract_only`

## 1. 目标

E3a 增加一层纯函数适配器，把实验台的 `IngestionEnvelope`、Evidence、Binding 和调用方注入的媒体字节转换为现有 Stage A 输入，再把 Stage A 输出映射回稳定的产品 `contentId`。

它只解决契约组合问题：

1. 分开并稳定映射 `contentId / evidenceId / photoId`；
2. 只有用户明确绑定到单张图片的说明才进入该图片的 Stage A 上下文；
3. 多图说明、批次说明和 AI 候选绑定不被复制成单图事实；
4. 时间 `role / precision`、地点类型和 Evidence 来源不在内容组织层丢失；
5. 一个断言可以由图片、文字和 final ASR 多个 Evidence 共同支持；
6. 纯文字和纯 final ASR 继续进入文字抽取链，不制造空图片或视觉模型调用。

产品继续以事件/故事为主要内容单元，人物、时间、地点、场景和主题作为筛选维度。E3a 不把 AI 候选升级为用户确认事实，不写长期 Memory。

## 2. Scope 与 Non-scope

E3a 包含：

- 严格解析 `classification-ingestion.2`；
- 生成 Stage A 输入计划和授权快照；
- 路由单图文字、final ASR、批次说明、多图说明和 AI 候选绑定；
- 建立图片 Evidence 与产品 Content 的双向 ID 映射；
- 组合 Stage A 与 Ingestion 的内容、观察、关联候选和审计信息；
- 保留用户原文、所有合法 supports、时间限定信息和地点判定状态；
- 相同显式输入生成相同 digest 与映射；
- 使用稳定错误码拒收跨范围、失活、篡改或未授权输入。

E3a 不包含：

- HTTP、页面 UI、Job 异步执行、队列、CAS、取消或晚到结果处理；
- API key、Keychain、环境变量、Qwen/GLM 或任何网络访问；
- Provider 选择、费用控制、自动重试；
- 数据库、Redis、对象存储或生产队列；
- 人脸身份匹配、生物特征、人物姓名或关系自动确认；
- 用户确认、长期 Memory 写入或阈值校准；
- 真实模型准确率、真实家庭泛化或产品效果判断。

执行生命周期属于 E3b，真实 Provider factory 属于 E3c，付费本地页面冒烟属于 E4，冻结 validation 属于 E5。

## 3. 接口

建议实现：

```ts
export interface StageALabPlanInput {
  envelope: IngestionEnvelope;
  payloads: IngestionPayloads;
  imageBytesByEvidenceId: Readonly<Record<string, Uint8Array>>;
  authorization: {
    actorId: string;
    authorityRef: string;
    scope: Scope;
    authorizationRevision: string;
    contextRevision: string;
    active: boolean;
    allowedEvidenceIds: readonly string[];
    allowedConsentRefs: readonly string[];
    allowedCorrectionIds: readonly string[];
    allowPersonMatching: boolean;
  };
  placeKindPolicy: {
    policyVersion: string;
    taxonomyVersion: string;
    genericLabels: readonly string[];
    policyDigest: `sha256:${string}`;
  };
  runId: string;
  trigger: Request['trigger'];
  budget: Budget;
  createdAt: string;
  references?: Reference[];
  corrections?: Correction[];
  trustedOriginalCaptureEvidenceIds?: readonly string[];
}

export interface StageALabPlan {
  version: 'classification-lab-stage-a-plan.1';
  stageA?: AdaptedStageAInput;
  baseOrganization: IngestionOrganizationOutput;
  routes: { images: ImageRoute[]; texts: TextRoute[] };
  audit: StageALabPlanAudit;
}

export function buildStageALabPlan(input: StageALabPlanInput): StageALabPlan;

export function composeStageALabResult(input: {
  plan: StageALabPlan;
  stageResult?: StageResult;
  textObservations?: ContentObservation[];
  createdAt: string;
}): StageALabCompositionOutput;
```

无活动图片时不是错误。`stageA` 为空，audit 记录 `skippedReason=no_active_images`，文字内容仍由 `baseOrganization` 进入后续链路。此时 `stageResult` 必须为空；存在 `stageA` 时 `stageResult` 必填，组合器对不一致输入 fail closed。

`authorization` 必须来自服务端授权目录，不能由客户端 Envelope 推导。E3a 校验 actor、scope、revision、active、Evidence/consent/correction allowlist；Correction 还必须携带与服务端授权一致的 `authorityRef`。当前 Lab 若 `allowPersonMatching=true` 则拒绝执行，然后再传给现有 Stage A adapter。Envelope 只描述用户本批提交，因此 E3a 冻结为 **batch-isolated Lab**：它验证本批抽取与组织接线，不宣称验证历史照片目录、跨批长期归组或增量 snapshot。完整授权历史 Catalog 属于 E3c/T2。

## 4. ID 映射

|来源|Stage A|产品输出|规则|
|---|---|---|---|
|`IngestionContent.contentId`|不直接交给模型|`ContentItem.contentId`|产品稳定 ID，最终必须恢复|
|图片 `evidenceId`|`Photo.photoId`|图片 Evidence 与 support|沿用冻结 Stage A 协议|
|图片 `sourceHash`|`Photo.sourceHash`|授权和审计|原样保留|
|文字/ASR `evidenceId`|`Photo.textEvidence[].evidenceId`|support Evidence|仅限单图用户明确绑定|
|Stage A `photoId`|映射键|原 `contentId`|observation、edge、group endpoint 都必须映射|
|Stage A `groupId`|保持内部候选 ID|人物/事件候选|不得变成确认身份|

路由结构：

```ts
interface ImageRoute {
  contentId: string;
  evidenceId: string;
  stagePhotoId: string;
}

interface TextRoute {
  bindingId: string;
  sourceContentId: string;
  evidenceId: string;
  modality: 'user_text' | 'final_asr';
  disposition:
    | 'stage_a_single_image'
    | 'deferred_multi_image'
    | 'preserved_batch'
    | 'ai_candidate_only'
    | 'non_image_target';
  targetContentIds: string[];
}
```

映射后的 `candidateId / associationId` 必须由 adapter version、原来源 ID 和映射后的 endpoint 重算，避免 opaque ID 与实际 endpoint 不一致。原 Stage A ID 留在 audit。

## 5. 文字与 final ASR 路由

文字进入某一张图片的 Stage A 上下文，必须同时满足：

- Binding 为 `active`；
- `authority=user_explicit`；
- `target.kind=contents`；
- 只有一个目标；
- 目标是活动图片；
- 来源是活动 `user_text` 或 final ASR；
- payload 字节长度和 SHA-256 与 Evidence 完全一致。

该文字仍保留为独立 `ContentItem`，原文不被 AI 标题或摘要覆盖。

组合时，调用方注入的文字 Observation 也必须重新校验：`contentId/evidenceId` 只能指向本批活动的
`user_text` 或 final ASR，support 的 `sourceType` 必须与原模态一致，`quote` 必须非空且经
NFKC、大小写和空白规范化后仍能在原文中找到。由抽取器生成的派生标签若不是原文逐字内容，support
必须回落到真实原文片段；不能把生成标签伪装成 Evidence quote。

多图说明不复制进每张 `Photo.textEvidence`，但保留用户明确的 `supports` 关联。批次级说明只留在 `batchBindings`；AI 可以提出候选关联，但不能擅自变成单图事实。`authority=ai_candidate` 永远不作为 Stage A 的可信文字 Evidence。

## 6. Evidence 与 supports

Stage A 来源映射：

|Stage A source|组织层 `sourceType`|Evidence ID|
|---|---|---|
|`visual`|`visual`|图片 Evidence|
|`ocr`|`ocr`|图片 Evidence|
|`exif`|`exif`|图片 Evidence|
|`user_text`|`user_text`|文字 Evidence|
|`final_asr`|`final_asr`|Transcript Evidence|
|`caption`|`caption`|当前 Lab 不生成独立 caption Evidence|

`ObservationSupportSchema` 增加可选 `sourceType`，Stage A 映射必须填写。

现有 `support.evidenceId === observation.evidenceId` 限制改为：

- `observation.evidenceId` 是 primary Evidence；
- primary 必须出现在 supports 中；
- 每个 support Evidence 都必须属于当前 Content 的 `evidenceIds`；
- supports 可引用多个不同 Evidence；
- foreign、withdrawn 或未授权 Evidence 继续 fail closed。

因此同一断言可以同时引用图片视觉、用户文字和 final ASR，而不会丢掉来源。

## 7. 时间限定信息

组织层 Observation 增加：

```ts
temporal?: {
  role: 'event' | 'capture' | 'scan' | 'upload';
  precision: 'date' | 'year' | 'decade' | 'relative';
}
```

无法安全赋予角色的时间使用固定 sidecar：

```ts
interface UnresolvedTemporalObservation {
  observationId: string;
  contentId: string;
  rawValue: string;
  normalizedValue: string;
  role: 'role_unknown';
  precision: 'date' | 'year' | 'decade' | 'relative';
  sourceRefs: string[];
  evidenceKinds: Array<
    'user_text' | 'final_asr' | 'visual_content' | 'ocr_candidate' |
    'trusted_original_exif' | 'scan_system_event' | 'server_upload_event'
  >;
  reason: 'untrusted_capture' | 'role_missing';
  e2RuntimeObservation?: {
    observationId: string;
    facet: 'time';
    kind: 'visible_time_text';
    rawValue: string;
    normalizedValue: string;
    role: 'role_unknown';
    precision: 'exact_day' | 'year' | 'decade' | 'relative';
    sourceRefs: string[];
    evidenceKinds: ['ocr_candidate'];
  };
}
```

只有来源恰好可归为 `ocr_candidate` 的可见时间文字才能生成 `e2RuntimeObservation`，并按 E2 Schema 把 `date` 映射为 `exact_day`。由文字、ASR 或其他来源触发的 `untrusted_capture` 只留在审计 sidecar 和 review，不伪造成 E2 当前只接受的 `visible_time_text`。

Stage A 的 `facet=time` 必须携带 `temporal`，其他 facet 禁止携带。`.12` 继续执行 EXIF-only `capture`：只有调用方显式列入 `trustedOriginalCaptureEvidenceIds`，并继续通过 Stage A Guard 的原始 EXIF 才允许映射为 `capture`；默认空列表。普通 `EvidenceRecord.capturedAt` 不自动成为可信原始 EXIF。

当前底层 Guard 仍可能接受由 OCR 或文字支持的 `capture`，所以 E3a 必须增加第二道边界：任何没有可信原始 EXIF support 的 `capture` 都不进入 `ContentObservation`，而是保存为 `unresolvedTemporalObservations` 并产生 `ROLE_UNKNOWN_TIME` review。E3a 不静默改成 `event`。OCR 中的日期如果缺少时间角色也进入同一 sidecar，不能在 E3a 被猜成 `event/capture/scan/upload`。

## 8. 地点类型

`.12` Stage A 输出没有原生 `placeKind`，E3a 不使用未版本化的字符串启发式强行二分类。调用方必须注入与 Envelope taxonomy 匹配、带 `policyDigest` 的冻结 `placeKindPolicy`；adapter 对 `{policyVersion,taxonomyVersion,sortedUniqueGenericLabels}` 计算稳定 `digest` 并校验，再把 policy 绑定到 `inputDigest`。中间层使用：

```ts
placeKind?: 'named' | 'generic' | 'unresolved';
```

冻结规则：

1. 命中 `placeKindPolicy.genericLabels` 时为 `generic`；
2. 有显式 `canonical` 且未命中 generic taxonomy 时为 `named`；
3. 其余为 `unresolved` 并产生 `PLACE_KIND_UNRESOLVED` 复核项。

E2 runtime 只接受 `named/generic`。`unresolved` 不得伪装成确定类别，也不得导出为非法 runtime place prediction。若未来要求模型直接返回 `placeKind`，必须升级 Prompt 和 Stage A contract，不能暗改 `.12`。

## 9. 组合结果

`composeStageALabResult` 输出：

```ts
interface StageALabCompositionOutput {
  contents: ContentItem[];
  observations: ContentObservation[];
  retrievalCandidates: RetrievalCandidate[];
  explicitAssociations: AssociationCandidate[];
  batchBindings: BatchEvidenceBinding[];
  reviewItems: string[];
  unresolvedTemporalObservations: UnresolvedTemporalObservation[];
  audit: StageALabCompositionAudit;
}
```

规则：

- `contents` 以 `baseOrganization.contents` 为准；
- 图片 Content 合并图片 Evidence 与单图路由文字 Evidence；
- Stage A observation 的 `contentId` 恢复为产品 `contentId`，support Evidence ID 不改写；
- 文字抽取 Observation 与 Stage A Observation 稳定合并；
- edge/group endpoint 恢复为产品 `contentId`；
- 用户明确 Binding 仍是 `user_confirmed supports`；
- Stage A 的 AI edge/group 保持 `ai_inferred`；用户 Correction 产生的 user-origin event edge 必须继续保留 `user_explicit` authority；
- `needs_review` 可以保留局部 snapshot；
- `failed/cancelled` 且无 snapshot 时不生成伪结果，由 E3b 设置 Job 终态。

组合器只接受与当前请求匹配的 Stage A 结果：`providerVersion` 必须等于 snapshot `version`，
snapshot `contextHash` 必须等于本次请求、引用、Correction、授权摘要和 Provider 版本计算出的 hash
（允许明确的 `incomplete:` 前缀）；缓存 Observation 的 input hash/version、Edge/Group 严格结构、
依赖 hash 和 support 都会重新验证。禁用人物匹配时，人物 edge、跨图片人物组或 identity 一律拒收。
合并后的 retrieval candidates 再经过 `validateSparseAssociationInput` 校验，防止直接拼接绕过数量、
端点和关系约束。

## 10. 错误与复核

Fatal 错误使用稳定代码：

- `DUPLICATE_ID_MAPPING`
- `DUPLICATE_CORRECTION`
- `MISSING_IMAGE_ASSET`
- `FOREIGN_IMAGE_ASSET`
- `SOURCE_LENGTH_MISMATCH`
- `SOURCE_HASH_MISMATCH`
- `PARTIAL_ASR_NOT_ALLOWED`
- `CROSS_SCOPE`
- `NOT_AUTHORIZED`
- `INACTIVE_EVIDENCE`
- `AUTHORIZATION_CHANGED`
- `INACTIVE_AUTHORIZATION`
- `PERSON_MATCHING_NOT_ALLOWED`
- `PERSON_MATCHING_NOT_AUTHORIZED`
- `PLACE_KIND_POLICY_MISMATCH`
- `PLACE_KIND_POLICY_DIGEST_MISMATCH`
- `STAGE_A_RESULT_MISMATCH`
- `STAGE_A_SNAPSHOT_REQUIRED`
- `DUPLICATE_STAGE_A_EDGE`
- `FOREIGN_TEXT_OBSERVATION`
- `FOREIGN_STAGE_A_SUPPORT`
- `STAGE_A_OBSERVATION_FOR_INACTIVE_CONTENT`
- `STAGE_A_OBSERVATION_WITHOUT_SUPPORT`
- `STAGE_A_EDGE_FOR_INACTIVE_CONTENT`
- `TEXT_SUPPORT_REQUIRES_EVIDENCE`
- `INVALID_TEMPORAL_QUALIFIER`
- `OBSERVATION_PRIMARY_SUPPORT_MISSING`
- `FOREIGN_SUPPORT`
- `DUPLICATE_RETRIEVAL_CANDIDATE`
- `FOREIGN_RETRIEVAL_CONTENT`
- `DUPLICATE_RETRIEVAL_PAIR`
- `FOREIGN_RETRIEVAL_EVIDENCE`
- `RETRIEVAL_LIMIT_EXCEEDED`

最后七项来自 E3a 复用的组织/检索契约验证器；它们与本 adapter 自身错误码一样 fail closed，不能被
转换成空结果或静默丢弃。

以下进入 review，不作为 fatal：

- `PLACE_KIND_UNRESOLVED`
- `ROLE_UNKNOWN_TIME`
- 多图说明未进入单图事实；
- 批次说明等待关联；
- Stage A unknown relation 或 conflict。

## 11. 纯函数与幂等边界

E3a 不读取 `process.env`、文件、Keychain 或网络，不生成当前时间和随机数，不调用 Provider，不写 store，也不修改输入对象。`runId`、时间、预算、payload 与媒体字节都由调用方注入。

`inputDigest` 绑定 adapter version、完整规范化 authorization（actor、authorityRef、scope、revision、contextRevision、active、排序去重后的 Evidence/consent/correction allowlist、allowPersonMatching）、完整 Envelope、文字 payload hash、图片 source hash、最终 routes（包括 `bindingId`）、taxonomy version 和 `placeKindPolicy.policyDigest`。同一个 authorization revision 下只要 allowlist、active 状态或上下文改变，digest 就必须改变。Provider/model/prompt/scorer 的完整 run identity、并发与 CAS 属于 E3b。

## 12. Source Gate

E3 Source Gate 为 `PASS_WITH_CONDITIONS`。E3a 直接复用：

- `adaptTrustedStageACatalog`
- `adaptIngestionForOrganization`
- `adaptStageAForOrganization`
- `ContentObservationSchema`
- `RetrievalCandidateSchema`
- Stage A Guard 与 `AuthorizationSnapshot`

这是 SGX 专用契约翻译层，没有适合直接复制的外部实现，因此自研薄适配器且不新增依赖。Node `AbortSignal`、p-queue、write-file-atomic、lowdb、proper-lockfile 和 openai-node 只作为后续 E3b/E3c 语义参考；未复制上游代码。

## 13. 测试矩阵

聚焦测试至少覆盖：

1. 单图 + user text；
2. 单图 + final ASR；
3. 图片、文字和 ASR 共同支持一个 Observation；
4. 多图说明不被复制；
5. batch 说明只留在 batch binding；
6. AI candidate 不进入可信 Stage A 输入；
7. 纯文字/final ASR 返回 `no_active_images`；
8. 三类 ID 双向映射；
9. edge/group/association endpoint remap，并保留 user-origin correction authority；
10. time role/precision 保留；
11. 非 time facet 不能携带 temporal，非可信 EXIF 的 `capture` 降级到 sidecar；
12. `placeKind=named/generic/unresolved`；
13. unresolved place 不伪造成 E2 runtime 输入；
14. 多 Evidence support 可用且 primary 有来源；
15. foreign support 拒收；
16. scope、subject、authorization drift 拒收；
17. withdrawn/deleted 内容不能保留结果；
18. 缺失或篡改媒体/文字 payload 拒收；
19. partial ASR 拒收；
20. `needs_review` 局部 snapshot 可组合；
21. failed/cancelled 无 snapshot 不产生假结果；
22. 同输入两次输出和 digest 相同；
23. 输入对象不被修改；
24. 测试期间 `externalCalls=0`、`credentialsRead=false`、`costCny=0`；
25. deterministic Lab 回归保持通过。
26. Correction allowlist、重复 correction ID 和 `authorityRef` 防伪；
27. Provider/snapshot version、context hash、缓存 input hash/version、严格 Edge/Group 拒收；
28. 人物匹配关闭时拒绝人物 edge、跨图人物组和 identity；
29. 文字 Observation 的模态、Evidence、`sourceType` 和原文 quote 重新校验；
30. 合并后的 retrieval candidates 再走语言无关契约验证；
31. `usableForOrganization=false` 的 Group 不产生 retrieval candidate。

## 14. 完成条件

E3a 只有同时满足以下条件才算完成：

- 聚焦测试覆盖上述关键路由与拒收边界；
- typecheck、secret scan、全量分类回归和 `git diff --check` 通过；
- 无网络、无凭据、无付费模型；
- 单图说明没有丢失，多图与批次说明没有扩散；
- 时间 role/precision 和多个 Evidence supports 可追溯；
- unresolved `placeKind` 没有被伪装成确定类别；
- deterministic Lab 行为兼容；
- 文档明确该阶段只证明集成契约，不代表模型准确率或产品效果。

## 15. 实现与验证记录

E3a 已由以下入口实现：

- `src/lib/algorithms/classification/lab-stage-a-composition.ts`：生成纯 `StageALabPlan`，并组合
  Stage A 与文字抽取结果；
- `src/lib/algorithms/classification/stage-a-organization-adapter.ts`：严格校验并映射 Stage A
  snapshot、Observation、Edge 和 Group；
- `src/lib/algorithms/classification/content-organization.ts`、
  `contracts/classification-hybrid.schema.json`：支持多 Evidence support、`sourceType`、时间限定信息和
  `placeKind`；
- `src/lib/algorithms/classification/text-extractor.ts`：为文字/final ASR support 保留可回查的原文 quote。

2026-09-30 验证证据：

- 允许 loopback 的受控环境中，`npm run test:classification` 为 **328/328 通过**；
- `npm run typecheck`、`npm run test:classification:secret` 和 `git diff --check` 通过；
- 当前实现不读取凭据、不联网、不调用模型，`externalCalls=0`、`costCny=0`。

独立终审先得到 P0=0、P1=0、P2=1；唯一 P2 是不可用于组织的 Group 仍可能生成候选。该项已在
提交前修复并增加回归，最终没有遗留的已知 P0/P1/P2。

因此 E3a 只证明 batch-isolated Lab 的**离线集成契约**可执行。它不证明真实模型准确率、真实家庭
泛化、页面产品闭环、生产存储或长期 Memory 已就绪。下一项为 E3b 两阶段 execution lifecycle；
真实 Provider factory 仍属于 E3c。

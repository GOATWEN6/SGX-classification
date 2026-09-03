# 多模态自动分类归纳算法 P0 设计规格

> 文档状态：`draft_for_owner_review`
> 版本：`0.1.0`
> 日期：2026-09-04
> 适用分支：`codex/multimodal-classification-p0`
> 主要读者：产品、算法、后端、Android/相框、测试、数据标注、科研负责人

## 1. 执行摘要

本规格定义五大算法中的第一个算法：多模态自动分类归纳。P0 面向每位老人连续 4 周、通常 20–50 张照片，少量超过 50 张，并同时接收文字和语音转写。系统把输入转换成有来源、有置信度、可确认、可更正、可删除的多维标签和生命记忆候选，不把模型推断直接当作老人真实经历。

技术路线采用已经确认的方案 C：现有 Next.js 后端继续承担产品编排；客户端只调用稳定的产品 API；算法通过语言无关的版本化契约接入。P0 可以使用 TypeScript 规则、已有模型 API 或其组合建立基线；当 Python/GPU 模型经过离线验证后，再在不改变客户端契约的情况下替换算法实现。

本轮只批准算法研发和必要接口建设，不自动改变当前产品发布范围。根 PRD 当前仍把“复杂照片自动分类”列为非 MVP；何时把本算法展示给线上用户，需要单独经过产品发布决策。

## 2. 决策来源与事实状态

### 2.1 已确认的产品决策

- 产品线优先，科研线并行，但科研工作不能阻塞或污染产品体验。
- 输入模态从 P0 起包含图片、文字和语音，而不是只预留图片接口。
- 图片采用多标签分类，可按时间、地点、人物、事件等维度组合筛选。
- 个人内容默认私密；长期圈层可见由内容主体授权；敏感内容和跨圈分享逐条确认。
- 一个家庭圈可有多位老人，但每条证据、每次会话和每条 Memory 必须明确 `subjectId`。
- 产品数据进入科研侧前必须额外同意、去标识化、冻结版本并按研究协议处理。
- P0 先完成分类归纳；家庭互动洞察只预留接口。

### 2.2 当前代码事实

以下状态已从当前 checkout 核验：

- 产品主仓库是 Next.js 14 + TypeScript 应用。
- 已有会话编排、实时语音、候选 Memory 的确认/拒绝/编辑接口。
- 当前分类主要是关键词规则，一段文字至多产生一个粗粒度候选。
- 当前文件存储记录和 JSON 数据层适合本地原型，不是生产级对象存储或数据库。
- 当前没有正式的照片分类入口、异步任务队列、算法注册表和分类评测 harness。
- 根目录中的 `ai-frame-main/` 是未纳入当前 Git 跟踪的原型材料，不是本规格的实现基线。

### 2.3 与当前 PRD 的关系

当前 PRD 明确支持照片上传、相框展示、基础删除和对象存储，同时把自动分类、智能标签和复杂相册工作台排除在当前 MVP 之外。本规格是经用户明确授权建立的算法研发 P0，属于后续产品能力准备。研发完成不等于默认上线；产品是否启用通过 feature flag 和单独验收控制。

### 2.4 Owner 决策记录

| 项 | 决策 |
|---|---|
| 批准人 | SGX 项目/产品负责人（当前仓库所有者） |
| 批准日期 | 2026-09-04 |
| 决策来源 | 当前项目对话中的明确指令：“确认方案 C”“开始进行执行” |
| 覆盖的 PRD 条目 | 仅覆盖 PRD 中“当前 MVP 不开发自动分类/智能标签”的**研发优先级**；不覆盖老人端/家属端当前发布范围 |
| 已授权 | 本文档包、版本化 schema、合成 fixtures、fake provider、确定性 baseline、离线 harness、关闭状态的 feature flag 集成 |
| 尚未授权 | 修改当前产品 UI、接入真实家庭数据、调用付费/外部模型、生产部署、真实用户 pilot、自动分享或自动写入正式 Memory |
| 发布条件 | 另行完成产品评审、权限与删除验收、真实数据授权、模型数据外发 preflight 和 pilot gate |

因此，本规格的 Phase 0 和不使用真实数据的 Phase 1 可以进入实施计划；其他阶段仍需相应授权。当前 PRD 图库默认上限 20 张保持不变。算法评测所述“每人 20–50 张”是 4 周内来自图库、互动、访谈材料或受控导入的总样本量，不等于把图库 UI 上限改为 50。

## 3. 目标、非目标与成功标准

### 3.1 P0 目标

1. 统一接收图片、文字和最终语音转写。
2. 为内容生成多维、可解释的分类候选。
3. 每个语义判断都能追溯到原始证据、算法和版本。
4. 低置信度或证据冲突时正确拒判或请求确认。
5. 经用户确认的结果可以进入分层 Life Memory；未确认结果不得成为正式人生事实。
6. 为 Android、数字相框、小程序、后端和未来 Python 模型提供稳定契约。
7. 用真实 pilot 记录修正率、耗时、拒判和失败分母，为下一轮研发提供证据。

### 3.2 明确不做

- 不训练自有大型视觉基础模型。
- 不根据人脸自动确定真实身份；P0 只可生成“同一人物聚类候选”或使用用户已明确提供的身份。
- 不从照片、语音或文字推断疾病、认知状态、家庭关系质量、人格或动机。
- 不自动公开、跨圈分享或发布故事。
- 不把 AI 生成故事或润色文本回灌成原始证据。
- 不让科研 Notebook、实验数据库或付费模型密钥直接进入客户端。
- 不在本规格中实现用户洞察、认知风险或紧急报警。

### 3.3 P0 产品成功标准

P0 同时看技术效果和用户负担，不能只看分类准确率：

- 可处理率：满足格式和质量要求的输入中，完成分类任务的比例。
- 证据追溯率：所有语义标签均关联输入证据和算法版本。
- 用户确认率：候选中被确认、修改、拒绝和跳过的比例。
- 人工修正成本：确认一条内容所需操作数与时间。
- 无依据标签率：人工复核发现不能由证据支持的标签比例。
- 拒判质量：不确定样本是否进入 `needs_review`，而非被强行归类。
- 删除完整性：回收、恢复、永久删除能否覆盖衍生标签、索引和缓存。
- 体验结果：老人和家属是否认为整理负担下降，是否出现困惑、冒犯或隐私担忧。

这些指标只能说明 P0 pilot 表现，不能直接形成广泛人群或临床科学主张。

## 4. 总体架构

```text
Android 相框 / App / 小程序
          │
          │ REST + SSE/WebSocket；不携带模型密钥
          ▼
Next.js 产品编排层
  ├── 身份、主体、家庭圈、授权
  ├── 上传会话与对象访问
  ├── Evidence Repository
  ├── Classification Job Orchestrator
  └── Memory Candidate Review
          │
          │ AlgorithmProvider 版本化契约
          ▼
  ┌──────────────┬──────────────┬────────────────┐
  │ TS/规则基线  │ 模型 API 适配器 │ Python 推理服务 │
  │ P0 可直接用  │ 可配置、可回滚   │ 验证后再启用     │
  └──────────────┴──────────────┴────────────────┘
          │
          ▼
审核后的 ClassificationAssertion
          │
          ▼
候选 MemoryClaim → 用户确认/修改 → Canonical Memory
```

### 4.1 边界原则

- 客户端不感知具体模型和供应商。
- 算法不直接修改正式 Memory，只返回候选判断。
- 实时语音主链路不等待分类任务；最终转写产生后异步分类。
- 文件二进制不穿过模型契约反复复制；算法通过短期授权引用读取。
- 产品数据库和科研数据集之间没有直接查询通道。
- 所有 provider 必须支持超时、取消、重试、幂等和版本记录。

## 5. 核心数据契约

契约使用 JSON Schema/OpenAPI 表达，并在 TypeScript、Python 和 Android 侧生成或校验类型。字段可以扩展，但已有字段不能在同一主版本中改变语义。

### 5.1 `EvidenceRecord`

| 字段 | 含义 |
|---|---|
| `evidenceId` | 全局唯一证据 ID |
| `schemaVersion` | 证据契约版本 |
| `subjectId` | 内容主要描述的老人；必填 |
| `ownerId` | 原始素材的权利主体，通常是上传/提供该素材的人 |
| `contributorId` | 上传、说话或补充内容的人 |
| `householdId` | 家庭空间 |
| `circleId` | 当前内容所属圈层，可为空 |
| `modality` | `image`、`text`、`audio`、`transcript` |
| `sourceRef` | 受保护的对象引用或消息引用，不是公开 URL |
| `sourceHash` | 原始内容哈希，用于完整性和去重 |
| `capturedAt` | 拍摄、录音或产生时间；可为空 |
| `ingestedAt` | 进入系统的时间 |
| `quality` | 尺寸、模糊度、ASR 置信度等模态质量信息 |
| `visibility` | 默认 `private`，以及经授权的长期可见范围 |
| `consentRef` | 对应授权版本 |
| `lifecycleState` | `active`、`trashed`、`deletion_pending`、`deleted` |

`EvidenceRecord` 的“不可篡改”只表示原始内容不能被 AI 静默覆盖。主体、权限、纠错和删除通过追加版本、修订记录和墓碑表达；原始内容本身保持内容哈希可验证。

### 5.2 身份和授权对象

| 字段 | 定义 |
|---|---|
| `actorId` | 发起当前操作的已认证账号或服务主体 |
| `accountId` | 产品登录账号；一个账号可在不同圈层承担不同任务 |
| `subjectId` | 这条生命记忆主要描述的老人；一条 MemoryClaim 只能有一个主 `subjectId` |
| `depictedPersonRefs` | 图片中其他已确认或匿名人物引用，可有多个；不自动获得真实身份 |
| `ownerId` | 原始素材所有者，通常是上传者/贡献者；控制自己的原始素材 |
| `contributorId` | 提供原声、文字或图片的人 |
| `householdId/circleId` | 当前资源的隔离域和可见范围，不代表自动授权 |
| `authorityType` | `self`、`explicit_delegate`、`legal_representative`、`service_processing` |
| `authorityRef` | 授权、委托或服务处理依据的版本化记录 |

内部权限可以精确，老人端 UI 不需要展示复杂角色切换。所有写操作必须记录 `actorId`、`authorityType`、`authorityRef` 和资源版本。

#### Actor–resource–action 矩阵

| 操作 | 默认允许者 | 约束 |
|---|---|---|
| 上传原始素材 | 贡献者 | 必须声明用途、主体和圈层；不能替他人授权研究使用 |
| 查看原始素材 | 素材所有者、内容主体及被显式授权者 | 使用最小可见范围；圈管理员无天然查看权 |
| 运行产品分类 | `service_processing` | 只能处理当前授权、`active` 的素材 |
| 确认个人 MemoryClaim | 内容主体本人 | 可由显式委托或合法代理代办，但必须记录依据；贡献者只能确认自己提供的原话/说明，不得替主体确认私密人生事实 |
| 修改/撤回贡献内容 | 贡献者 | 撤回原声或补充内容后触发派生结果重算/失效 |
| 改变长期可见范围 | 内容主体本人 | 跨圈和敏感内容逐条确认；多人共同内容采用最严格有效限制 |
| 移入/恢复回收站 | 素材所有者；内容主体可从自己的 Memory 中移除 | 恢复前重新检查现行权限和 consent |
| 永久删除原始素材 | 素材所有者，或依法享有删除权的内容主体/代理 | 删除传播到全部派生对象；冲突时优先执行更严格的隐藏与停止处理 |
| 研究导出 | 研究数据管理员服务 | 每位相关受试者需有效研究 consent；普通圈管理员和产品客服不得执行 |

群像照片允许一个主要 `subjectId` 加多个 `depictedPersonRefs`。这里的 `subjectId` 表示照片进入哪位老人的生命记忆空间，不要求该老人是照片中唯一人物；其他画面人物可以保持匿名。无法选定当前老人时，客户端只能保留未提交的本地 staging 项，不能创建 Evidence、运行分类、写入个人 Memory 或进入研究样本。当前只按 `userId` 检查的 Memory/Family API 不能直接作为新权限层；实施前必须包在新授权服务后或完成安全迁移。

### 5.3 `ClassificationJob`

| 字段 | 含义 |
|---|---|
| `jobId` | 任务唯一 ID |
| `idempotencyKey` | 同一输入和配置重复提交时复用结果 |
| `subjectId` | 防止跨老人混淆 |
| `evidenceIds` | 输入证据列表 |
| `requestedFacets` | 本次需要的标签维度 |
| `taxonomyVersion` | 标签体系版本 |
| `algorithmVersion` | 编排和后处理版本 |
| `providerVersion` | 模型/规则/provider 版本 |
| `status` | `pending`、`processing`、`succeeded`、`needs_review`、`failed_retryable`、`failed_terminal`、`cancelled` |
| `attemptCount` | 重试次数 |
| `createdAt/startedAt/finishedAt` | 生命周期时间 |
| `errorCode` | 稳定、可聚合的错误码，不写隐私原文 |

`idempotencyKey` 至少覆盖 `schemaVersion + subjectId + 有序 evidence hashes + requestedFacets + taxonomyVersion + algorithmVersion + providerVersion + relevantConfigHash`。算法或配置变化后允许产生新任务，不能错误复用旧版本结果。

### 5.4 `ClassificationAssertion`

| 字段 | 含义 |
|---|---|
| `assertionId` | 单条判断 ID |
| `jobId/evidenceIds` | 运行与证据来源 |
| `subjectId` | 当前老人主体 |
| `facet` | `time`、`place`、`person`、`event`、`scene`、`theme`、`content_type`、`quality` |
| `rawValue` | 输入中出现或模型产生的原始值 |
| `normalizedValue` | 规范化值及命名空间 |
| `confidence` | 0–1，必须与 provider 版本共同解释 |
| `supports` | 支持证据列表；每项包含 `evidenceId`、来源类型、producer/version、文本跨度或图片区域、可选权重 |
| `state` | `proposed`、`confirmed`、`edited`、`rejected`、`conflicted`、`revoked` |
| `sensitivity` | 内容敏感级别；仅作治理，不代替授权 |
| `createdAt/updatedAt` | 审计时间 |

一个融合结果可以同时有多个 support，不使用单值 provenance 覆盖来源。

### 5.5 与当前 Memory 类型的映射

| 新对象 | 当前对象 | 迁移规则 |
|---|---|---|
| `EvidenceRecord` | `sourceSessionId/sourceMessageId/evidenceText` | 当前字段只作为迁移来源；新写入必须生成独立 Evidence ID |
| `ClassificationAssertion` | 无直接等价物 | 新增；只表达单个 facet 判断，不是长期记忆 |
| `MemoryClaim` | `MemoryCandidate` | 通过兼容适配器生成；保留当前确认/编辑/拒绝语义并补主体、证据、权限和版本 |
| `CanonicalMemory` | `MemoryCard` | 当前 `MemoryCard` 仅作过渡存储；完成权限与冲突迁移后才能视为正式 Canonical Memory |

Assertion 不必全部生成 MemoryClaim，例如“图片模糊”“室外场景”通常只用于整理。只有与生命事实相关且满足权限和证据规则的 Assertion 才能进入 MemoryCandidate 适配器。

### 5.6 算法运行元数据

每次运行必须记录：

```text
runId
schemaVersion
algorithmName
algorithmVersion
providerName
providerVersion
modelVersion
promptVersion
taxonomyVersion
inputHash
latencyMs
tokenOrComputeUsage
status
```

模型、prompt、taxonomy 任一变化都必须产生新版本，不能只覆盖名称相同的配置。

## 6. 分类标签体系

### 6.1 时间 `time`

支持精确日期、年份、年代、相对时间和人生阶段：

- `exact_date`：例如 1982-05-01。
- `year` / `decade`：例如 1982 年、80 年代。
- `relative`：例如“退休前两年”，必须保留原表达和锚点。
- `life_stage`：童年、求学、工作、婚育、退休等候选。
- `interval`：不能确定单点时，用起止范围表达。

模型不得把模糊服饰、建筑风格单独转换为精确年份。

### 6.2 地点 `place`

同时保存用户原话和规范化层级：国家、省/州、城市、区县、具体地点。图片 GPS 可以作为元数据证据，但向其他圈层展示前仍执行隐私策略。不能根据模糊景物强行确定详细地址。

### 6.3 人物与关系 `person`

- 用户明确标注的人名和关系具有最高优先级。
- 可对视觉特征生成匿名人物簇，如 `person_cluster_7`。
- 人脸相似不等于真实身份；未经确认不得自动命名。
- 同一照片可关联多人，并区分内容主体、上传者和画面人物。

### 6.4 事件 `event`

P0 提供小型可扩展受控集合：求学、工作、婚礼、生日、节庆、旅行、搬家、退休、家庭聚会、兴趣活动、纪念事件、其他。允许自由文本候选，但不能为扩充标签而虚构事件。

### 6.5 场景、主题与内容类型

- 场景：室内家庭、校园、工作场所、户外、交通、庆典、自然景观等。
- 主题：亲情、友情、师生、事业、成长、兴趣、传统与其他。
- 内容类型：个人照、合照、证件/文档、物品、风景、截图、老照片翻拍等。
- 质量：模糊、过暗、遮挡、低分辨率、重复/近重复。

### 6.6 圈层和隐私不是普通分类标签

算法可以建议“可能与家庭相关”或“可能包含敏感信息”，但不能据此自动改变可见范围。最终权限由内容主体或其合法授权流程决定。

## 7. 多模态处理流水线

### 7.1 图片

```text
上传初始化
→ 客户端计算基本信息与校验和
→ 直传对象存储
→ 创建 EvidenceRecord
→ EXIF/OCR/质量/重复检测
→ 场景、内容类型、匿名人物簇候选
→ 与用户说明、已确认 Memory 做受限融合
→ 生成多标签 Assertion
→ 用户确认/修正
→ 可选生成 MemoryClaim 候选
```

原图、缩略图和推理派生物分别管理。模型只读取完成病毒/格式检查且仍处于 `active` 状态的对象。

### 7.2 语音

实时语音链路只负责对话体验。ASR 产生最终转写后：

```text
音频 EvidenceRecord
→ TranscriptSegment（含 ASR 版本和置信度）
→ 文本分类
→ 与会话主题和已确认 Memory 融合
→ 候选 Assertion/MemoryClaim
```

ASR 错误不能被下游算法当成高置信事实。低 ASR 置信度应降低覆盖率或请求确认。

### 7.3 文字

文字输入先做分句和原子事实切分，再分别识别人、事、时、地、物和主题。一条消息允许产生多条候选，而不是沿用当前“一段文字一个候选”的限制。

### 7.4 跨模态融合

融合只提升候选证据强度，不改变原始证据。优先级为：

```text
用户明确确认
> 用户明确输入
> 原始元数据
> 已确认 Memory
> 确定性规则
> 模型推断
```

来源冲突时保留多个判断并标记 `conflicted`，不以最后写入者覆盖。

## 8. 确认、冲突和拒判

- 所有语义标签初始为 `proposed`；技术标签如文件格式和校验和可以系统确认。
- 用户可确认、编辑、拒绝或暂时跳过。
- 内容主体决定个人隐私和对外范围；贡献者可撤回自己的原声和补充内容。
- 同一事实出现不同时间、地点或人物时，系统保留证据版本并请求最小必要确认。
- 低质量、越权、输入缺失或模型不确定时进入 `needs_review`。
- P0 不设置不可解释的全局“自动写入阈值”。每个 facet 的阈值在冻结评测集上单独校准。

## 9. 产品 API 与 Provider 契约

### 9.1 建议的产品 API

```text
POST   /api/v1/media/uploads:init
POST   /api/v1/media/uploads/{uploadId}:complete
GET    /api/v1/jobs/{jobId}
GET    /api/v1/classification/assertions?evidenceId=...
PATCH  /api/v1/classification/assertions/{assertionId}
POST   /api/v1/content/{contentId}:trash
POST   /api/v1/content/{contentId}:restore
DELETE /api/v1/content/{contentId}
```

客户端不直接创建 Evidence 或 ClassificationJob。上传完成后，后端重新校验对象归属、MIME、大小和服务端可验证的 checksum，再在一个受控流程中创建 Evidence 并自动创建 Job。客户端 SHA-256 是传输提示，不是服务端信任根。手工重跑 Job 仅提供给经过授权的内部运维命令。API 命名可在实施计划中按现有 Next.js 路由风格微调，但语义不能改变。

### 9.2 内部 ClassificationJob 创建参数示例

以下对象由完成权限和上传校验后的后端 orchestrator 生成，再传给任务层；客户端不得直接发送该对象创建 Evidence 或 Job。

```json
{
  "schemaVersion": "1.0",
  "subjectId": "elder_123",
  "evidenceIds": ["ev_img_001", "ev_text_001"],
  "requestedFacets": ["time", "place", "person", "event", "scene", "theme"],
  "taxonomyVersion": "2026-09-04.p0",
  "idempotencyKey": "sha256:..."
}
```

### 9.3 `AlgorithmProvider`

Provider 对产品层暴露统一能力：

```ts
type ProviderStatus =
  | 'succeeded'
  | 'needs_review'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'cancelled';

interface ClassificationProviderRequest {
  runId: string;
  idempotencyKey: string;
  schemaVersion: '1.0';
  taxonomyVersion: string;
  evidence: Array<MinimalAuthorizedEvidenceRef>;
  requestedFacets: ClassificationFacet[];
  deadlineAt: string;
}

interface ClassificationProviderResult {
  runId: string;
  providerVersion: string;
  status: ProviderStatus;
  assertions: ProviderAssertion[];
  facetErrors: Array<{ facet: ClassificationFacet; code: ProviderErrorCode }>;
  usage: { latencyMs: number; inputUnits?: number; outputUnits?: number };
}
```

`cancel(runId)` 是尽力取消：产品层一旦把任务标记为 `cancelled` 或资源进入删除流程，任何晚到 provider 结果都必须丢弃。部分 facet 成功时返回成功 assertions 和对应 `facetErrors`；结果在持久化前必须通过 schema、权限、主体、版本和 evidence 引用检查。

产品层负责权限、证据读取授权、任务状态、重试、后处理和持久化；provider 不直接读写产品数据库。

## 10. 错误处理与降级

| 情况 | 产品行为 |
|---|---|
| 上传中断 | 客户端保留任务并支持续传/重试 |
| 文件损坏或格式不支持 | 明确提示；不创建可推理任务 |
| 图片质量过低 | 保存内容但标记质量问题，不强行分类 |
| provider 超时 | 首次进入 `failed_retryable` 并有限退避；超过最大尝试后进入 `failed_terminal` |
| provider 不可用 | 保留原内容；不影响相框展示和实时对话 |
| 重复提交 | 根据 `idempotencyKey` 返回已有任务 |
| 证据已进回收站 | 取消未开始任务，隐藏衍生结果 |
| 权限或主体不一致 | 拒绝处理并写入不含隐私正文的审计事件 |
| 部分 facet 成功 | 保存成功项，失败项单独记录，不整批丢弃 |

## 11. 隐私、回收站与删除传播

- 默认可见范围为个人私密。
- 家庭圈、学生圈等长期可见范围由内容主体设置。
- 敏感内容和跨圈分享逐条确认。
- 回收站保留期使用配置项 `TRASH_RETENTION_DAYS`；建议初始值 30 天，最终值待产品负责人确认。
- 回收期间内容不可参与新推理、Memory 检索或推荐，但允许授权人恢复。
- 永久删除必须传播到原文件、缩略图、Assertion、索引、缓存、待执行任务和研究导出映射。
- 已进入不可回滚训练产物的数据必须在研究同意书和数据治理中提前说明；P0 默认不把产品数据用于训练。

### 11.1 删除传播矩阵

| 对象 | trash/撤回时 | 永久删除时 | 多证据规则 |
|---|---|---|---|
| 原始媒体 | 停止展示、下载和新处理 | 删除主对象及派生副本；保留不可反推内容的最小墓碑 | 不适用 |
| EvidenceRecord | 标记不可用并取消排队任务 | 删除内容引用与 support span；保留 ID、删除代次、时间和执行状态 | 单条证据撤回只影响引用它的结果 |
| Assertion | 隐藏并标记待重算 | 删除无其他有效证据的结果；有其他证据则重算置信度与 supports | 不允许保留已删除证据的摘要或区域 |
| MemoryClaim/CanonicalMemory | 停止检索；显示为待处理冲突 | 若失去全部有效证据则撤销；仍有独立证据时生成新版本并请求复核 | 不能静默维持原置信度 |
| Job/Run | 取消；拒收晚到结果 | 删除输入快照正文，保留最小状态/版本/错误码审计 | 重跑必须基于当前有效证据 |
| 日志/监控 | 立即停止新增正文 | 按日志保留策略清除可识别内容；安全审计仅保留最小必要字段 | 哈希不得用于重新关联已删除内容 |
| 备份 | 标记排除，禁止在线恢复后复活 | 按备份到期策略清除；恢复演练必须重放删除墓碑 | SLA 在生产前冻结 |
| 外部 provider | 停止后续调用 | 按供应商合同执行删除/零保留；无法满足则禁止发送真实数据 | 需保存不含内容的删除凭证 |
| 研究导出 | 生成排除清单和新数据集版本 | 移除可定位样本；按研究协议处理已训练产物 | P0 默认不训练；例外须预先写明重训或不可逆限制 |

任何删除步骤失败都进入可重试队列和运维告警。内容应先对用户隐藏，再完成后台物理清理；具体在线隐藏、主存储清除和备份到期 SLA 在生产设计中冻结。

## 12. 产品与科研隔离

科研侧只通过版本化导出任务获得数据：

```text
产品证据
→ 检查独立研究同意
→ 最小化与去标识化
→ 人工质量检查
→ 冻结 ResearchSample
→ 研究数据集版本
```

- 科研代码不得直连产品数据库。
- 同一老人、同一家庭及其内容切片不能跨训练集和测试集。
- 纵向评估必须保持时间顺序，不能把未来会话泄漏给过去预测。
- 研究模型上线需依次通过离线评测、安全审查、shadow mode 和有限 pilot。
- 聚合研究结论可支持后续研发，但 P1 个体预测不能自动影响用户或家属。
- 每个 ResearchSample 保存 point-in-time 输入快照、标签来源、标注者是否看过模型输出以及算法暴露状态。
- 待评模型产生的候选不能回流成为该模型自身的输入特征或 gold label；gold 标注应对模型输出盲化，并由独立复核形成。

### 12.1 外部模型与 Prompt Injection 门禁

图片 OCR、图片中文字、文件名、语音转写和用户文本全部是不可信数据：

- provider 无工具、数据库、网络搜索或消息发送权限。
- 系统指令与证据内容使用固定边界封装，证据中的“忽略规则”等文字只作为数据。
- 输出必须符合固定 JSON Schema；自由文本、未知字段和越权 evidence 引用被拒绝。
- 限制 MIME、像素、字节、文本长度、图片数量和处理时限。
- golden/security fixtures 必须包含图片文字注入、转写注入、超长输入和恶意元数据。
- 真实外部调用前核验供应商地域、retention、是否用于训练、删除能力、子处理方、预算和最小外发字段。
- 未完成开源/license Source Gate、数据外发 preflight 和负责人批准时，只允许 fake/baseline provider。

## 13. 测试与评测设计

### 13.1 测试层级

1. Schema contract：TypeScript、Python、Android 对同一 fixtures 校验一致。
2. Unit：归一化、冲突、幂等、删除传播、权限判定。
3. Golden set：人工确认的图片/文字/语音样本，保留失败分母。
4. Integration：上传、Evidence、任务、Provider、确认、Memory、删除闭环。
5. Device E2E：Android 平板弱网、离线、重启、重复点击、大图、权限失败。
6. Pilot：4 周真实使用，观察效果、修正负担和隐私体验。

### 13.2 数据与切分

- 近期产品评估窗口统一为 4 周：约 10–30 位老人，每人计划 3–5 次访谈。
- 图片规模：多数每人 20–50 张，少数超过 50 张。
- 由主标注员完成日常标注，独立复核员交叉检查关键样本；产品负责人只处理争议裁决。
- 训练、开发、测试按 `subjectId` 和 `householdId` 分组切分。
- 同一图片的缩略图、裁剪、压缩版本和文字描述必须处于同一 split。
- 每次评测保存 point-in-time 输入快照；未来确认、后续会话和测试集反馈不得进入较早预测的特征。

### 13.3 标注规范与质检

- 标注单位：每个 Evidence × facet；人物框、OCR 区域和文本事实保存精确 support span/region。
- 多选规则：一张图可以有多个 `person/event/theme`；`content_type` 可设一个主类和多个辅类。
- `uncertain`：证据可能支持，但标注者无法稳定确定。
- `not_applicable`：该 facet 对当前素材不适用。
- `conflicted`：多个有效来源互相矛盾，不能通过现有证据裁决。
- 第一轮用 30–50 个素材做指南校准，不进入最终 held-out test。
- 正式数据至少随机双标 20%，所有敏感、冲突和低置信样本双标；争议由独立复核员处理，产品负责人只裁决定义问题。
- 分类标签报告 Cohen's kappa/原始一致率，多标签报告 per-facet F1，证据跨度报告 span/region overlap；不只报告一个总分。
- 若关键 facet 一致率低于 85% 或 kappa 低于 0.70，先修订指南并重新校准，不把该批直接称为 gold。
- 标注者制作 gold 时默认看不到待评模型预测；无法盲化时必须记录并单独报告。
- taxonomy 变化产生新版本和迁移映射，旧标签不得无记录覆盖。

`unsupported assertion` 不是 gold 标签状态，而是模型预测与盲化 gold 比对后得到的评测错误类型；必要时由没有参与原始标注的复核员检查。

### 13.4 核心指标

- 各 facet micro/macro precision、recall、F1。
- 多标签 exact match 与 Hamming loss。
- unsupported assertion rate。
- calibration error 与 risk-coverage curve。
- 重复/近重复检出率。
- 冲突发现率和错误覆盖率。
- 用户确认、编辑、拒绝、跳过比例及耗时。
- 每张图片端到端延迟、失败率和单位成本。
- 按老人、设备、图片年代、清晰度等分组的最差组表现。

P0 不预设未经数据验证的准确率承诺。具体发布阈值在第一版 golden set 建立后冻结。

### 13.5 当前可判定工程 Gate

在没有真实 gold 之前，只判定工程基础，不声称分类效果：

- 所有 positive/negative schema fixtures 通过，非法 provider 输出 100% 被拒绝。
- 同一幂等键并发或连续提交 10 次，只产生一个有效 Job 和一组 Assertion。
- 权限负例中跨家庭、跨主体、无授权处理成功数为 0。
- 删除集成 fixtures 中原件、派生物、Assertion、Memory adapter、缓存索引传播状态覆盖率为 100%。
- provider 超时、部分失败、取消和晚到结果均有自动化测试。
- secret scan 无生产凭证，普通日志 fixtures 无隐私正文。
- 任一跨家庭泄漏、删除内容复活、未经确认写入正式 Memory 或真实数据未经批准外发，立即停止本阶段。

算法效果 Gate 在完成标注校准后，基于冻结 dev/test 数据另行写入版本化评测协议，不能在看到 test 结果后倒推阈值。

## 14. 分阶段交付

### Phase 0：契约与 harness

- 冻结 v1 JSON Schema。
- 建立 fixtures 和跨语言契约测试。
- 建立 `AlgorithmProvider` 接口和 fake provider。
- 建立运行、版本、错误和幂等记录。

### Phase 1：确定性基线

- 图片元数据、OCR 接口、质量和哈希去重。
- 文字分句、明确时间地点和关键词分类。
- 多候选输出、确认、冲突和删除传播。
- 不依赖昂贵模型即可跑通全链路。

### Phase 2：模型增强（未来、需额外批准）

- 在完成开源与 license 评估后接入视觉/多模态 provider。
- 使用冻结 golden set 比较规则、LLM/VLM 和混合方案。
- 只在有可测增益时替换某个 facet，不整体重写系统。

### Phase 3：产品 pilot（未来、需额外批准）

- Android/相框真实设备 E2E。
- 10–30 位老人、4 周观测。
- 分析修正负担、失败分母和隐私反馈。
- 决定是否进入更大样本和产品功能发布评审。

## 15. PRD 与团队可追溯矩阵

| 来源 | 本规格对应 |
|---|---|
| PRD B：照片与语音对象存储及同步 | Evidence、上传、对象引用、删除传播 |
| PRD C：图库与相框播放 | 算法失败不阻塞图库展示；缓存保持客户端责任 |
| PRD D：语音对话 | 最终转写异步进入分类，不阻塞实时状态机 |
| PRD 隐私底线 | 默认私密、授权、受保护对象引用、无客户端密钥 |
| 当前用户覆盖决策 | 图片/文字/语音均为 P0；开始自动分类研发 |

## 16. 待产品负责人确认

以下参数不阻塞仅使用合成数据的 Phase 0，但实施到相关节点前必须确认：

1. 回收站是否采用建议的 30 天默认保留期。
2. P0 是否允许匿名人物聚类；默认建议允许，但不自动命名。
3. 第一版受控事件标签是否需要行业/地区定制。
4. 模型 API 的单月预算、允许外发的数据范围和供应商要求。
5. 实际试点中由老人本人还是被明确委托者承担主要确认工作；权限底线采用 §5.2 的矩阵，不允许普通家庭成员默认代为确认。

## 17. 设计完成与实现门禁

只有满足以下条件才进入实现：

- 产品负责人批准本规格或明确指出需要修改的章节。
- 独立规格审查没有阻塞性问题。
- 实施计划列出精确文件、测试、命令和小提交边界。
- 任何外部模型调用前完成数据外发范围、预算和凭证 preflight。

设计批准不等于算法效果验证；代码可运行不等于 pilot 成功；pilot 成功不等于形成科学主张。

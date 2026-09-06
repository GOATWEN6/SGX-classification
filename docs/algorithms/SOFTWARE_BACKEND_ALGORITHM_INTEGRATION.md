# 软件、后端、运维与算法协作契约

> 文档状态：`draft_for_backend_ops_review`
> 版本：`0.3.0`
> 日期：2026-09-06
> 主要读者：前端、Android、后端、算法、测试、运维和科研团队

## 1. 文档目的

本文件定义五大算法怎样接入当前 SGX 代码，并在未来迁移到生产数据库、对象存储、任务队列和 Python 模型服务时保持兼容。它描述工程边界和接口契约，不声称任何算法已经完成或验证有效。

### 1.1 文档所有权：算法负责人不应独自写完后端细节

这份文档存在的目的，是在算法开发前冻结“双方必须同意的边界”，不是让算法负责人替代后端和运维负责人。没有这层契约，即使离线模型有效，也可能出现客户端携带密钥、同步请求等待慢推理、跨老人写错 Memory、删除只删原图不删派生物、模型版本无法回滚等集成失败。

推荐采用共同所有制：

| 内容 | 主笔 | 必须评审/批准 | 说明 |
|---|---|---|---|
| Evidence/Job/Assertion 语义、taxonomy、provider 输入输出、质量指标 | 算法负责人 | 算法 + 产品 + 后端 | 这是算法负责人必须掌握的部分 |
| API 路径、认证授权实现、数据库/对象存储、任务队列、迁移 | 后端负责人 | 后端 + 安全 + 算法 | 算法负责人提出约束，不单独决定技术实现 |
| 部署、监控、告警、扩缩容、备份恢复、回滚 runbook | 运维/SRE 或后端负责人 | 运维 + 后端 + QA | 小团队中可以由后端兼任，但责任不能消失 |
| Web/PWA 请求和状态呈现；未来 Android 集成 | 全栈负责人 | 全栈 + 产品 + 算法 | 当前由同一位全栈负责人承担；客户端不能暴露 provider 和密钥 |
| 产品入口、确认负担、隐私文案、feature flag 和发布范围 | 产品负责人 | 产品 + 算法 + 客户端 | 算法研发授权不等于产品发布批准 |
| 契约、权限、删除、弱网和回滚测试 | QA 组织 | 对应模块负责人共同签字 | 测试证据决定是否能进入 pilot |

实际协作方式应是：算法负责人先发本草案；后端/运维负责人直接补充可实现方案和反例；组织一次 60–90 分钟接口评审；把争议写成 Decision Log；双方确认 v1 契约后，各自再写详细实现设计。后端可以修改数据库、队列、API 细节，不能单方面改变算法结果语义；算法也不能在没有后端确认的情况下冻结部署、容量和运维细节。

当前已确认首个真实集成端是 Web/PWA 产品原型。算法负责人交付契约、正反样例、Fake Provider、Real Provider 和离线评测；全栈负责人先用 Fake Provider 打通上传—分类—确认—修改—失败恢复，再通过同一契约换入达到 Gate 的 Real Provider。小程序本轮只复用/冻结 API；Native Android 和真实相框留到后续阶段。

## 2. 当前代码基线

### 2.0 授权和版本基线

- 2026-09-04，项目/产品负责人在当前项目对话中确认方案 C，并授权编写文档、版本化 schema、合成 fixtures、fake provider、确定性 baseline 和离线 harness。
- 该授权覆盖分类算法研发、Web/PWA 产品原型集成和浏览器 E2E，不改变 PRD 的正式发布范围。
- 真实家庭数据、外部/付费模型、生产基础设施、用户 pilot 和产品启用仍需分别批准。
- 当前根 PRD 文件仍是未跟踪文件；本轮文档提交不擅自把该用户文件加入 Git。它在纳入版本控制前是本地事实源，但不是可由 Git commit 完整复现的基线。

### 2.1 已验证可复用资产

| 能力 | 当前路径 | 状态 |
|---|---|---|
| 新会话编排 | `src/lib/conversation/index.ts` | 可作为产品编排入口继续演化 |
| 旧访谈入口 | `src/lib/interview-engine.ts`、`src/app/api/chat/route.ts` | 仍存在，需后续确定是否迁移/退役 |
| 模块化访谈草案 | `src/lib/interview-engine/` | 尚未确认进入主运行链路 |
| 当前 Memory | `src/lib/memory/index.ts` | 有候选、确认、拒绝、编辑最小闭环 |
| 另一套 Memory extractor | `src/lib/memory-extractor/index.ts` | 未确认主链路接入，不能再叠加第三套实现 |
| Memory API | `src/app/api/memory/candidates/` | 可复用状态语义，需扩展证据/主体/版本 |
| 实时语音 API | `src/app/api/voice/realtime/route.ts` | 可复用后端代理和状态机基础 |
| SSE 消息流 | `src/app/api/conversation/message/stream/route.ts` | 可继续服务对话，不承担慢分类 |
| 本地数据层 | `src/lib/db.ts` | JSON 原型存储，不作为生产数据库 |
| 语音 harness | `harness/voice-assistant/` | 可复制治理方式建立 classification harness |

### 2.2 当前缺口

- 没有照片上传完成后触发分类的正式接口。
- 没有 Evidence、ClassificationJob、Assertion 等统一实体。
- 没有对象存储适配器、生产任务队列和 worker。
- 没有算法/provider 注册、灰度、回滚和成本记录。
- 没有 OpenAPI/JSON Schema 以及 Android/Python 契约测试。
- 没有分类算法的 golden set、单元测试脚手架或 CI 门禁。

## 3. 推荐集成方式

采用渐进式混合架构：

```text
Client API
   ↓
Next.js Route Handler
   ↓
Application Service（权限、任务、幂等）
   ↓
Domain Contract（Evidence / Job / Assertion）
   ↓
AlgorithmProvider
   ├── FakeProvider（契约测试）
   ├── BaselineProvider（TS/规则）
   ├── RemoteModelProvider（受控模型 API）
   └── PythonServiceProvider（验证后）
```

P0 不先拆整套微服务。先在单仓库内建立清晰接口和可替换实现；只有出现独立扩缩容、GPU、依赖隔离或发布周期差异时，才把 provider 移出进程。

其中 `FakeProvider` 返回确定、可重复、可构造成功/失败/超时的测试结果，只证明产品集成链路正确，不证明算法质量；`BaselineProvider` 和后续真实视觉/多模态实现才属于 Real Provider。客户端只识别统一契约和状态码，因此更换 provider 不需要重写页面。

## 4. 建议代码边界

以下是实施计划的候选结构，最终以书面实施计划和现有风格复核为准：

```text
src/
  lib/
    evidence/
      contracts.ts
      repository.ts
    algorithms/
      contracts.ts
      registry.ts
      classification/
        service.ts
        taxonomy.ts
        normalization.ts
        providers/
          fake.ts
          baseline.ts
    jobs/
      contracts.ts
      repository.ts
      runner.ts
    content-lifecycle/
      service.ts
  app/api/
    evidence/
    classification/jobs/
    classification/assertions/
contracts/
  evidence.schema.json
  classification-job.schema.json
  classification-result.schema.json
harness/
  classification/
    fixtures/
    progress.json
    prd-traceability.json
scripts/
  classification-contract-test.mjs
  classification-secret-scan.mjs
```

每个目录只承担一个职责。分类算法不能直接调用 `src/lib/db.ts`；通过 repository 接口读写，便于未来替换 PostgreSQL、对象存储和队列。

## 5. API 设计原则

### 5.1 统一响应

沿用当前 API 风格：

```json
{
  "success": true,
  "data": {},
  "meta": { "requestId": "req_...", "schemaVersion": "1.0" }
}
```

错误响应使用稳定错误码，面向用户的中文提示由产品层生成；日志和客户端不依赖供应商错误原文。

### 5.2 身份与权限

- 当前认证身份、设备、家庭圈、内容主体和贡献者必须分字段表达。
- 所有 Evidence 和 Job 操作先做家庭/圈层权限检查。
- `subjectId` 必填，防止共用相框时把资料写入错误老人。
- 圈管理员只管理成员和秩序，不能越权公开内容主体的敏感内容。
- 研究身份不是产品 UI 角色；研究同意由单独 consent scope 表达。
- `actorId` 是操作者，`subjectId` 是被描述老人，`ownerId/contributorId` 管理原始素材权利；这些字段不能继续折叠成当前的 `userId`。
- 确认个人 Memory 默认由内容主体完成；显式委托/合法代理必须记录 `authorityType/authorityRef`。
- 贡献者可以撤回自己的原声和补充内容，但不能默认替老人确认私密人生事实。
- 多人共同内容采用最严格的有效可见限制；圈管理员没有天然内容查看、确认或公开权。
- 当前 Family/Consent/Memory 路由只按 `userId` 或资源 ID 判断的路径不可直接复用为新权限层，必须先加统一 authorization service 和 IDOR 负例测试。

### 5.3 异步任务

照片分类、长音频处理和跨模态融合使用任务状态机：

```text
pending → processing → succeeded
                    ├→ needs_review
                    ├→ failed_retryable → pending
                    ├→ failed_terminal
                    └→ cancelled
```

API 接收请求后快速返回 `202 + jobId`。实时对话和相框展示不能等待任务完成。

### 5.4 幂等与并发

- `idempotencyKey = hash(schemaVersion + subjectId + 有序 evidence hashes + requestedFacets + taxonomyVersion + algorithmVersion + providerVersion + relevantConfigHash)`。
- 同一键的并发请求只产生一个有效任务。
- provider 重试不得重复创建 Assertion 或 MemoryCandidate。
- 用户编辑结果时使用版本号或 ETag 防止后写覆盖先写。
- 删除墓碑优先于在途任务结果；晚到结果不得复活已删除内容。

所有文档和代码只使用上述七个 Job 状态。`failed_retryable` 只有在未超过最大尝试且授权/资源仍有效时才能回到 `pending`；`failed_terminal`、`cancelled` 和已删除资源不能自动重试。

## 6. 存储与队列迁移

### 6.1 本地开发

P0 初期可用 JSON/in-memory repository 和 fake queue 验证契约，但必须保持 repository 接口，不能让路由直接读写文件。

### 6.2 Pilot 后端

进入真实用户 pilot 前需要：

- 生产数据库：保存主体、授权、Evidence 元数据、任务和 Assertion。
- 对象存储：保存图片、音频、缩略图和有限派生物。
- 任务队列：提供重试、延迟、死信、取消和 worker 可见性。
- 缓存：只能作为可重建加速层，删除和权限变更可使其失效。
- 数据库迁移：schema 版本可追踪、可回滚，不由应用启动时隐式破坏数据。

### 6.3 数据生命周期

```text
active
→ trashed（不可推理、不可检索、可恢复）
→ deletion_pending（传播删除）
→ deleted（保留最小墓碑与审计）
```

原文件、缩略图、embedding、Assertion、Memory 派生、缓存和研究映射都必须登记删除传播状态。

### 6.4 删除权限与多证据结果

- 素材所有者可删除自己上传的原件；内容主体可撤回其个人 Memory 使用和对外可见范围。
- 两者冲突时先执行更严格的隐藏和停止处理，再由授权规则决定是否物理删除共享原件。
- Assertion 失去一条证据后必须重算 supports/置信度；失去全部证据则撤销。
- Canonical Memory 仍有独立有效证据时生成新版本并复核，不得静默保留原置信度。
- 删除任务必须覆盖外部 provider 留存、备份、日志、缓存和研究导出；无法满足删除要求的 provider 不得接收真实数据。
- 研究撤回产生新数据集版本和 exclusion manifest；P0 默认不使用产品数据训练模型。

## 7. AlgorithmProvider 契约

Provider 的职责：

- 接收经过权限检查、最小化的证据引用。
- 返回结构化候选、置信度、支持证据和 provider 元数据。
- 支持超时和取消。
- 不直接写产品数据库、不决定可见范围、不发送用户消息。

产品编排层的职责：

- 认证、授权、主体和生命周期检查。
- 生成最小访问凭证。
- 幂等、重试、结果验证和 schema 校验。
- 保存运行版本、成本和错误状态。
- 把合法结果转成待确认 Assertion/MemoryCandidate。

外部 provider 返回自由文本或不符合 schema 时，任务失败或进入隔离区，不能直接透传到产品。

唯一规范源是 `contracts/*.schema.json` 和后续 OpenAPI；本文件只解释语义。Provider 请求必须包含 `runId/idempotencyKey/schemaVersion/taxonomyVersion/evidence/requestedFacets/deadlineAt`，响应必须包含统一 Job 状态、结构化 assertions、facet 级错误、版本和 usage。取消采用“产品层状态最终有效”：晚到结果一律丢弃。

图片 OCR、文件名、EXIF、转写和文字全部是不可信输入。外部 provider 不拥有工具、数据库、搜索或消息发送权限；输出需要严格 schema 校验。真实调用前必须完成 prompt-injection fixtures、供应商 retention/training/地域/删除条款、最小外发字段和预算审批。

## 8. 五算法的接入顺序与本轮边界

1. 分类归纳：首先建立 Evidence、Job、Assertion 和确认闭环。
2. AI 访谈：消费已确认 Memory，产生新的原始会话证据。
3. Life Memory：管理候选、确认、冲突、检索、撤回和删除。
4. 用户洞察：只读取允许范围内的确认 Memory 和行为事件，输出可解释建议。
5. 认知研究：独立 consent、存储、数据集和 shadow runtime，不读取普通派生故事。

紧急生命安全事件使用另一套安全链路，不进入上述依赖链。

本轮实施第 1 项的算法 Phase 0/1、Web/PWA 原型接入和浏览器 E2E。第 2–5 项在本文中是兼容性约束，不是当前 Worker 的完成清单。

## 9. 版本、发布与回滚

每个结果都记录：

```text
schemaVersion
algorithmVersion
providerVersion
modelVersion
promptVersion
taxonomyVersion
inputHash
featureFlag
```

发布遵循：

```text
离线评测
→ 冻结测试集
→ 安全/隐私审查
→ shadow mode
→ 小流量 pilot
→ 产品发布评审
```

- champion/challenger 结果分开存储，challenger 不自动显示给用户。
- 回滚只切换 provider/版本，不需要更新 Android App。
- 新版本不能覆盖旧运行结果；需要可复现实验输入和配置。
- 线上回滚后保留失败版本记录和影响范围。

## 10. 可观测性

### 10.1 每个任务的诊断字段

- `requestId/runId/jobId`。
- 算法、provider、模型、prompt、taxonomy 和 schema 版本。
- 输入模态与数量，不记录隐私正文。
- 队列等待、推理、后处理和总延迟。
- 尝试次数、状态、错误码和降级路径。
- token/compute/外部 API 成本。
- 结果数、拒判数、人工确认/修改/拒绝状态。

### 10.2 运行面板

运维至少能看到：

- 成功率、重试率、死信任务、p50/p95 延迟。
- 各 provider 错误率和成本。
- 各 facet 的覆盖率、拒判率和人工修改率。
- 删除传播积压和权限失败。
- schema/version 分布，发现旧客户端或旧 worker。

原始照片、完整对话、健康信息和秘密不得出现在普通监控标签中。

## 11. 测试与质量门禁

### 11.1 自动化

- JSON Schema positive/negative fixtures。
- TypeScript contract tests。
- provider fake、超时、非法结果和取消测试。
- 幂等、并发、晚到结果和删除墓碑测试。
- 权限、跨主体、跨家庭访问测试。
- 分类后处理和 taxonomy migration 测试。
- API integration tests。
- TypeScript build/typecheck。
- secret scan。

当前分类 Phase 0 的判定阈值：schema 正反 fixtures 全部通过；非法 provider 输出全部拒绝；同一幂等键重复 10 次只产生一个有效 Job；权限负例成功数为 0；删除 fixtures 的登记传播覆盖率为 100%。算法准确率阈值必须在盲化标注、冻结 dev/test 和基线完成后预先确定。

### 11.2 算法评测

- 冻结 golden set，保存数据集、标注规范和版本。
- 报告全部样本数、失败数、拒判数，不能只报告成功子集。
- 按老人/家庭切分，禁止同人、同图变体或同一故事跨 split。
- 人工标注主标注员负责日常工作，关键样本由独立复核员交叉检查。

### 11.3 分阶段端到端验收

本轮执行 Web/PWA 浏览器验收：上传、状态轮询、分类结果、确认、修改、删除/失败恢复，以及 Fake/Real Provider 切换后页面契约不变。以下 Native Android/真实设备项目是未来 Gate，本轮不作为完成条件：

- Android 弱网/断网/重启/重复点击。
- 共享相框的主体切换。
- 相框播放不被慢分类阻塞。
- 语音打断、ASR 失败和返回路径。
- 隐私确认、回收站、恢复和永久删除。

没有自动化和人工验收证据时，不得把功能状态标为 `verified`。

## 12. CI/CD 建议门禁

P0 建立最小 CI 时按以下顺序：

1. install with lockfile。
2. contract/schema tests。
3. unit/integration tests。
4. `npm run build` 或明确 typecheck。
5. secret scan。
6. classification harness smoke。
7. 生成不含隐私正文的测试报告。

需要外部模型的测试默认不在普通 PR CI 中执行；使用 fake provider。真实 provider smoke 由受控环境、预算批准和专用测试数据触发。

## 13. 产品与科研数据桥

建立单向、可审计的 export adapter：

- 输入：具有独立研究同意的 Evidence ID 集合。
- 处理：最小化、去标识化、质量检查、冻结版本。
- 输出：ResearchSample manifest 和受控对象包。
- 禁止：科研代码查询产品线上表、把研究预测写回用户界面。

研究产物如需成为产品 provider，必须附数据集版本、模型卡、离线报告、安全审查、shadow 结果和回滚方案。

ResearchSample 还必须保存 point-in-time 输入快照、标签来源和算法暴露状态。待评模型产生的候选不能成为自己的输入特征或 gold label；gold 制作默认对模型输出盲化。

## 14. 团队协作与所有权

| 角色 | 主要责任 |
|---|---|
| 产品负责人 | 产品边界、默认权限、用户确认流程、发布决策 |
| 算法负责人 | taxonomy、provider、评测、版本、失败分析 |
| 全栈负责人 | API、权限、Evidence、任务、存储、删除传播、当前 Web/PWA 和未来 Android 集成 |
| 硬件负责人/供应商接口人 | 真实相框能力、设备约束和后续设备验收 |
| 标注与质检 | 按冻结规范标注，记录争议和不可判定 |
| QA/运维 | 契约、E2E、监控、故障演练和回滚证据 |
| 科研负责人 | 伦理、研究同意、数据切分和科学主张边界 |

一人可以兼任多个角色，但每个发布门禁仍需明确负责人，不能因“目前团队小”而省略证据。

## 15. 近期工程顺序

1. 书面批准分类 P0 SPEC。
2. 建立 schema、fixtures 和 contract test。
3. 建立 repository 与 fake provider。
4. 全栈负责人用 Fake Provider 在 Web/PWA 跑通“上传 → 后端校验 → Evidence → Job → Assertion → 确认/修改/失败恢复”；客户端不能直接创建 Evidence/Job。
5. 接入当前 MemoryCandidate 的确认语义。
6. 建立 baseline provider 和离线 harness。
7. 完成开源/license 评估后决定 OCR/VLM provider；达到离线 Gate 后用同一契约换入 Real Provider，并完成浏览器 E2E。
8. 小程序只冻结共用 API；Native Android、真实相框及硬件性能验收进入后续阶段。

每一步形成独立、小范围、可回滚 Git commit。

步骤 1–6、Web/PWA 原型接入和浏览器 E2E 属于当前已授权范围。未经授权的真实家庭数据、外部/付费 provider、生产启用、老人 pilot、Native Android 和真实设备操作仍需重新过批准门禁。步骤 7 的开源/license 调研可以只读进行；若 Real Provider 是本地/自托管实现，可在 Source Gate 与离线 Gate 后接入原型，若涉及数据外发或费用则仍需专门批准。

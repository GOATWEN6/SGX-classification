# SGX 多模态自动分类：GPT-6 新任务交接包

> 文档状态：current_handoff
> 版本：1.0.0
> 日期：2026-09-06
> 目标模型：gpt-6-astra
> 工作目录：/Users/wenqingzhong/Documents/SGX
> 当前分支：codex/multimodal-classification-p0
> 任务二基线提交：929e83b

## 1. 新任务怎样使用本文件

新任务开始后，先阅读本文件，再依次阅读第 12 节列出的 anchor documents，并核验当前 Git 状态。不要只依赖聊天摘要或历史 Memory；当前 checkout、用户新指令和最新文档优先。

本文件是上下文与所有权交接，不代表任务一已经完成，也不授权外部/付费模型调用、真实家庭数据外发、生产部署、老人 pilot、git push 或真实硬件操作。

## 2. 当前目标和工作顺序

产品长期目标：通过 AI 持续理解老人及其家庭，沉淀可确认、可追溯、可更正的生命记忆，并把这种理解转化为故事、访谈、洞察和更有效的家庭关怀。

当前只聚焦“五大算法核心 + 必要接口契约”。现阶段顺序已经确认：

1. 任务二先完成：形成自动分类的业务关系、数据流程、权限、产品—科研和团队责任边界基线。
2. 任务一随后开始：实现 Schema、测试样例、Fake Provider 和 contract tests。
3. 全栈负责人使用 Fake Provider 打通 Web/PWA 产品闭环。
4. 算法负责人继续开发 Baseline/Real Provider 和离线 evaluation harness。
5. Real Provider 达到离线 Gate 后，通过同一接口替换 Fake，并执行 Web/PWA 浏览器 E2E。
6. Native Android、真实相框和老人 pilot 后续另行批准。

任务二文档和图示已经在提交 929e83b 完成并通过技术检查，当前状态为 ready_for_owner_review；下一步是任务一。

## 3. 决策权和事实优先级

- 用户本人是算法负责人，也是当前算法主力开发与团队协调者。
- 创始人的意见是战略、资源与发布决策的最高依据；算法负责人提供专业判断并参与讨论。
- 发布决定权归创始人。
- 算法开发完成、产品集成完成、pilot 准备完成和生产发布完成必须分开报告：
  - algorithm_ready：真实算法离线达到预先冻结的效果 Gate。
  - integration_ready：Web/PWA 产品链路使用统一 API 端到端跑通。
  - pilot_ready：真实数据、权限、删除、体验、安全和停止规则通过。
  - production_ready：监控、成本、扩缩容、回滚和发布批准完成。
- 设计文档、Schema 绿测或 Fake Provider E2E 不能自动形成算法效果或科学主张。

事实优先级：

1. 新窗口中用户的当前明确指令。
2. 当前 PRD；若用户当前指令明确覆盖某一条，则记录覆盖原因。
3. 本交接包和最新算法规格/Decision Log。
4. 当前 checkout 的代码与实际测试产物。
5. 历史对话和 Memory 仅用于检索线索。

## 4. 产品、用户和场景共识

### 4.1 产品形态

- 当前：Web/PWA 产品原型。
- 未来：Android App、小程序和嵌入 App 的数字相框。
- 本轮首个真实集成端是 Web/PWA。
- 小程序本轮只冻结和复用统一 API，不开发客户端。
- 本轮不接真实相框、不开发 Native Android、不做硬件性能验收。
- 有硬件负责人或相框供应商技术接口人；进入真实设备阶段后再参与约束和验收。
- 当前全栈负责人同时负责后端、Web/PWA 和未来 Android App 集成。

### 4.2 核心用户和关系

- 核心是老人及其家庭，家庭圈权重最高。
- 未来可以邀请学生、朋友等成员组成学生圈或其他圈层；他们可使用邀请链接、小程序或 App。
- 家庭圈允许多位老人，但每次会话、每台相框的当前使用、每条 Evidence、Memory 和认知基线都必须明确 subjectId。
- 共用相框可以切换账户/当前主体；算法不得通过人脸或历史行为猜当前老人。
- 个人内容默认私密。
- 用户可设置家庭圈、学生圈等长期可见范围；敏感内容和跨圈分享逐条确认。
- 内容所描述的老人决定其个人隐私、长期 Memory 和对外可见范围。
- 贡献者可以修改或撤回自己的原声和补充内容。
- 圈管理员只管理成员与秩序，不能越权公开他人的敏感内容。
- 共同生成故事发布前，需要处理各贡献者授权。
- 角色系统要尽量简单，不能要求老人频繁切换复杂角色；权限复杂性主要在后端表达。

### 4.3 当前产品主线

- 礼品场景是当前主线，以荣休、婚龄、入住、贺寿、校友五类为主。
- 礼品前置共创：亲友先上传照片、语音祝福和说明，形成初始记忆包。
- 老人开箱后，基于初始记忆包产生欢迎与首次访谈引导。
- 银发广场保留，但当前不继续优化。
- 视频暂不进入自动分类 P0。

## 5. 五大算法的当前定义

| 算法 | 核心目标 | 当前边界 |
|---|---|---|
| 多模态自动分类归纳 | 从图片、文字和最终语音转写生成可追溯、多标签、可确认的分类候选 | 当前 P0 主任务 |
| AI 访谈 | 低压力地获得更多可确认、可追溯的生命记忆；动态选择倾听、追问、确认、换题、暂停或退出 | 被倾听感、疲劳和安全退出不可牺牲 |
| 分层 Life Memory | 证据层、确认事实/事件层、对话偏好/禁忌/短期上下文层分开管理 | 来源、权限、冲突、更新、遗忘和删除分别治理 |
| 用户洞察与推荐 | 基于允许范围内的确认 Memory 和反馈，向老人及家庭提供可解释、可关闭的个性化建议 | 家庭优先但权限先于关系权重；学生圈等未来扩展 |
| 认知状态研究、干预与风险流程 | P0 适老化；P1 经同意的纵向 shadow research；P2 临床、伦理、外部验证后才可人工复核提示与转介 | 不诊断；P1 个体预测不影响产品；紧急报警走独立链路 |

紧急生命安全事件如跌倒、胸痛、自伤表达，不与认知趋势模型混合。当前没有授权自动报警。

## 6. 自动分类 P0 冻结范围

### 6.1 输入

允许以下组合，说明不完整不是错误：

1. 照片 + 可选文字说明。
2. 照片 + 语音链路产生的最终 ASR 转写。
3. 照片 + 文字 + 最终 ASR 转写。
4. 只有照片。
5. 只有文字。
6. 只有最终 ASR 转写。

本轮不直接分类原始音频波形。未来认知研究可能单独使用声纹、语气、韵律、情绪或认知状态特征，但必须使用独立 consent、数据和评测链路。

### 6.2 输出

P0 目标 facet：

- 时间。
- 地点。
- 人物候选。
- 事件。
- 场景和主题。
- 内容类型与质量。
- 重复/近重复关系。
- 每条判断的 evidenceRefs、置信度、算法/模型/taxonomy/schema 版本。

隐私级别可以产生风险提示，但不能由算法自动改变可见范围。

### 6.3 处理原则

- 使用统一 ContentBundle / Evidence 模型，不为照片、文字和语音建立三套割裂流程。
- 图片、EXIF、OCR、文字和最终转写先独立提取证据，再按 facet 融合。
- 模态缺失不等于冲突。
- 来源冲突必须并存并进入确认，不能用最后一次写入覆盖。
- 允许 no_assertion 或 needs_review；高质量拒判优于编造结果。
- 礼品场景只能帮助选择候选和提问，不能证明具体人生事实。
- 故事生成或润色文本是派生内容，不能回灌为原始证据。

### 6.4 人物与人脸能力

- 文本中明确出现的人名/关系可以抽取为候选，仍保留来源与确认状态。
- F1 人脸检测：数量、区域和质量；可进入 P0。
- F2 匿名人物聚类：判断多张照片中可能是同一人，不自动命名；只在 feature flag 下受控验证。
- F3 家庭闭集身份建议：只在经确认、经同意的有限家庭人物库中建议候选；当前暂缓。
- F4 开放网络真实身份识别：不做。
- 人脸相似不等于真实身份；姓名只能来自明确说明、确认 Memory、授权人物库或用户确认。
- F2/F3 涉及敏感生物信息、独立同意、误认纠错、模板生命周期和删除传播，不能只看模型准确率。

### 6.5 部署方向

P0 推荐云端统一分类 + 客户端轻量预处理：

- 客户端：格式/尺寸检查、压缩、哈希、允许范围内读取 EXIF、上传队列和状态。
- 产品后端：身份、subjectId、权限、Evidence、Job、结果校验、确认、删除和审计。
- 算法层：OCR、视觉理解、文字抽取、F1、融合、置信度和拒判。
- Provider 密钥不能出现在浏览器。
- 外部/付费模型调用前必须确认数据外发范围、供应商保留/训练/地域/删除条款和预算。

## 7. 核心对象与边界

### 7.1 业务对象

- ContentBundle：一次分类请求关联的多模态内容集合。
- EvidenceRecord：图片、原始文字、最终 ASR 转写及其来源、哈希、授权和生命周期。
- ClassificationJob：异步、幂等、可取消、可重试的分类运行。
- ClassificationAssertion：某个 facet 的算法候选，必须带 evidenceRefs 和版本。
- MemoryClaim：从已确认且具有生命事实价值的 Assertion 转换出的候选。
- Canonical Memory：经授权确认的、可追溯、可更正、可撤回和可删除的正式记忆。

### 7.2 身份字段

- actorId：当前操作的人。
- subjectId：内容主要描述或归入生命记忆空间的老人。
- ownerId：原始素材权利主体。
- contributorId：上传或补充素材的人。
- deviceId/accountId 不得替代 subjectId。

### 7.3 状态边界

Job 统一使用：

pending -> processing -> succeeded / needs_review / failed_retryable / failed_terminal / cancelled

Assertion 至少表达：

proposed / confirmed / edited / rejected / conflicted / withdrawn

具体枚举由任务一 Schema 冻结，不得在前端、后端和算法各自创造不同状态。

## 8. Schema、测试样例和 Fake Provider 的准确含义

### 8.1 Schema

Schema 是算法与全栈共同遵守的机器可校验数据契约，规定必填字段、类型、枚举、版本和非法输入。字段多本身通常不是性能瓶颈；照片、音频和模型特征才是主要存储与带宽成本。Schema 应区分核心字段、可选 facet 和后端审计字段，避免无目的堆字段。

### 8.2 测试样例

- Contract fixtures：验证格式、状态、权限和异常行为，不衡量真实算法准确率。
- Golden Set：经过规范、盲化复核和冻结的数据，用于评价 Real Provider 的 Precision、Recall、F1、拒判与校准。

任务一至少覆盖：正常、多模态缺失、证据冲突、低置信、非法 MIME/字段、缺 subjectId、跨家庭越权、删除中、超时、取消、晚到结果和 provider 非法输出。

### 8.3 Fake Provider

Fake Provider 是后端真实 Provider 接口后的确定性算法替身。它能够按测试场景返回成功、needs_review、conflicted、超时、部分失败和非法结果，让全栈负责人先实现真实上传和确认闭环。

Fake Provider 不是前端写死数据，不是真实分类算法，也不能支持算法效果或学术结论。Real Provider 达到离线 Gate 后，通过同一 AlgorithmProvider 契约替换。

## 9. 产品、科研和安全边界

- 产品优先，科研并行；科研不能阻塞或污染产品体验。
- 产品任何符合基本安全条件的老人都可以使用；研究是额外自愿加入的一层。
- P1 认知模型使用 shadow mode，个人预测不直接影响老人、家属或线上产品。
- 产品数据不能被科研代码直接查询。进入科研侧前需额外同意、最小化、去标识化、冻结版本和受控导出。
- 科研结果进入产品需要外部测试、安全/隐私评审、shadow 结果和可回滚发布。
- 不从照片、普通语音或一次对话推断疾病、认知状态、人格、家庭关系质量或真实动机。
- 不自动分享、跨圈公开、联系家属或写入正式 Memory。

## 10. 评测、数据与人员

### 10.1 计划数据规模

- 初期可接触约 10–30 位老人，并可能通过社区、养老机构、学校或医院扩展到 30 位以上。
- 每人计划 3–5 次访谈，持续约 4–6 周。
- 以 4 周评估时，每位老人通常提供 20–50 张照片，少量超过 50 张。
- 以上是未来 pilot/研究规划，不表示当前已经授权老人 pilot 或科研采集。

### 10.2 最小团队

- 算法负责人：冻结任务、taxonomy、Schema、模型、指标、实验和发布建议；不承担大量日常标注。
- 数据标注与质量专员：建议 0.8–1.0 FTE，负责主标注、规范、批次、golden set、错误分析和删除/撤回记录。
- 用户研究与独立复核协作员：建议 0.2–0.4 FTE，负责关键样本盲化复核、pilot 协调和老人/家庭体验反馈。
- 普通样本随机至少 20% 双标；敏感、冲突、低置信和新类别样本全部复核。

### 10.3 指标

- 各 facet micro/macro Precision、Recall、F1。
- 多标签 exact match、Hamming loss。
- unsupported assertion rate、拒判率和 risk-coverage。
- 人脸聚类 false merge / false split。
- 用户确认、修改、拒绝、跳过比例和操作时间。
- 上传到结果的延迟、失败率和成本。
- 按老人、年代、清晰度等分组的最差组表现。
- 必须保留全部样本、失败和拒判分母；不能只报告成功子集。

## 11. 日期与验收层级

- 2026-09-25：目标是 L2 internal demo。创始人、团队和展会演示人员可以真实上传、分类、查看、确认、修改和拒绝；不开放老人 pilot。
- 2026-10-03：争取自动分类基本稳定，并开始 AI 访谈落地。
- 2026 年 11 月初：AI 访谈 + Memory MVP 的精确内容仍需进一步讨论；算法可以先开发，但产品落地仍需集成与验收。

内部演示、算法可运行、产品集成、老人 pilot 和生产发布不得混写。

## 12. 已完成和可复用的文件

必须优先阅读：

1. docs/algorithms/MULTIMODAL_CLASSIFICATION_BUSINESS_AND_DATA_FLOW.md
   - 任务二正式产物；三张主图、七类边界、责任与任务一输入。
2. docs/superpowers/specs/2026-09-04-multimodal-classification-p0-design.md
   - 自动分类 P0 的完整技术/产品规格、对象语义、融合、人脸分层、指标和门禁。
3. docs/algorithms/SOFTWARE_BACKEND_ALGORITHM_INTEGRATION.md
   - 算法—全栈契约、API/Job/Provider/运维责任。
4. docs/algorithms/HARDWARE_ALGORITHM_INTEGRATION.md
   - 未来 Android/真实相框兼容契约；本轮不执行硬件验收。
5. docs/algorithms/FIVE_ALGORITHMS_OVERVIEW.md
   - 面向产品、内容和团队的五算法定义。
6. docs/algorithms/DATA_ANNOTATION_FEEDBACK_AND_OPTIMIZATION_OPERATIONS.md
   - 标注岗位、复核、用户反馈和调优闭环。

任务二图示：

- figures/sgx-classification-business-context.*
- figures/sgx-classification-data-flow-boundaries.*
- figures/sgx-classification-collaboration-sequence.*

已完成的关键 Git 提交：

- cb9023d docs: define multimodal classification architecture
- b8ad56b docs: define annotation and feedback operations
- a2c559f docs: clarify classification design decisions
- 972f4e0 docs: freeze prototype integration scope
- 929e83b docs: define classification business boundaries

## 13. 当前代码事实与仓库注意事项

- 当前项目是 Next.js 14 + TypeScript Web/PWA。
- 已有会话、实时语音、访谈和 MemoryCandidate 的部分基础。
- 当前分类主要是粗粒度关键词规则，不能视为 P0 自动分类完成。
- 当前没有正式照片分类入口、Evidence/ClassificationJob/Assertion 实现、正式分类 harness、生产对象存储、生产队列或完整算法注册表。
- src/lib/db.ts 是本地 JSON 原型层，不是生产数据库。
- ai-frame-main/ 是未跟踪的原型材料，不是当前实现基线。
- 银发AI相框-PRD:MVP.md 当前也是未跟踪文件；它是本地产品事实源之一，但没有用户明确指令时不要擅自加入 Git。
- 必须保留以上两个未跟踪目标，不修改、不删除、不顺手提交。
- 任何实现开始前先检查当前 Git status 和已有代码，以免覆盖用户或全栈负责人的改动。

## 14. 尚未冻结的问题

以下问题不要擅自伪装成已决定；不阻塞任务一最小契约时，可以使用可配置初值并记录：

1. 第一版 event/topic taxonomy 的最终集合与是否按礼品场景定制。
2. 回收站最终保留期；当前建议 30 天并保持可配置。
3. F2 匿名聚类是否纳入 9 月 25 日演示；当前只建议 feature flag/shadow。
4. 外部 OCR/VLM/人脸模型的最终选型、许可证、预算和数据外发范围。
5. 11 月初 AI 访谈 + Memory MVP 的精确验收范围。
6. 情绪、关系洞察的产品价值、误伤和安全边界。
7. 老人本人确认、明确委托者辅助确认在具体 UI 中的默认流程。
8. 真实 pilot 的招募、consent、研究协议和具体开始时间。

## 15. 新任务的下一步

下一步只执行任务一的第一小阶段：

1. 只读核验现有 API、MemoryCandidate、测试和 package scripts。
2. 写一份精确到文件的最小实施计划。
3. 冻结 v1 JSON Schema：
   - EvidenceRecord。
   - ClassificationJob request/state。
   - ClassificationResult / ClassificationAssertion。
   - AlgorithmProvider request/response/error。
4. 建立 positive/negative fixtures。
5. 建立 Schema/contract tests。
6. 建立 Fake Provider，至少支持 success、needs_review、conflicted、timeout、failed 和 invalid_output 场景。
7. 运行聚焦测试、TypeScript build/typecheck 和 secret scan。
8. 形成独立小提交，不添加真实模型依赖，不调用外部 API。

这一阶段的完成条件：

- 正反 fixtures 均被正确接受或拒绝。
- 同一状态和字段在 Schema、TypeScript、Fake Provider 和测试中一致。
- Fake Provider 可由场景参数稳定复现成功与失败。
- 测试明确写出 Fake 只验证 integration contract。
- 无真实家庭数据、密钥或外部模型调用。
- 未跟踪原型与 PRD 文件保持不变。

## 16. 推荐的新窗口首条指令

```text
你现在接手 /Users/wenqingzhong/Documents/SGX 的多模态自动分类 P0 开发，请使用 gpt-6-astra。

先完整阅读：
1. docs/handoffs/2026-09-06-multimodal-classification-gpt6-handoff.md
2. docs/algorithms/MULTIMODAL_CLASSIFICATION_BUSINESS_AND_DATA_FLOW.md
3. docs/superpowers/specs/2026-09-04-multimodal-classification-p0-design.md
4. docs/algorithms/SOFTWARE_BACKEND_ALGORITHM_INTEGRATION.md

然后核验当前 Git 分支、状态、相关代码和测试。不要重新讨论已经冻结的产品边界，也不要把设计、Fake Provider 或绿测称为真实算法完成。

本轮执行任务一的第一阶段：实现 v1 Schema、positive/negative fixtures、contract tests 和可切换 success/needs_review/conflicted/timeout/failed/invalid_output 的 Fake Provider。先给出精确到文件的最小计划，然后持续实现、验证并小提交。不得添加真实家庭数据、调用外部/付费模型、修改未跟踪的 ai-frame-main/ 或银发AI相框-PRD:MVP.md。

完成后报告：实际文件、测试证据、commit、仍未实现内容，以及 algorithm_ready / integration_ready 的真实状态。
```

## 17. 交接完成判定

本交接包完成的只是上下文迁移准备。新窗口读完 anchor documents、核验 checkout，并能准确复述“当前范围、责任边界、禁止事项、下一小阶段与完成条件”后，才算成功接手；之后立即进入任务一，不需要重新进行整轮需求访谈。

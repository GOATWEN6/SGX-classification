# SGX 自动分类与归纳：真实混合链 T1 与全栈交付完成计划

> 日期：2026-10-03  
> 分支：`codex/classification-contract-v1`  
> 架构基线：`sgx-classification-cloud-hybrid.1.0.0`  
> 当前 Prompt：`sgx-five-facets.16`  
> 交付目标：算法负责人完成 T0/T1，形成全栈工程师可接入产品 T2 的可运行 ZIP  
> 状态：执行中；本文取代旧计划中的“当前下一动作”，不覆盖历史记录

## 1. 最终目标

本轮必须交付一条真实可运行的自动分类与归纳链，而不是只交付 Schema、Fake Provider 或单项模型演示。

输入支持：

- 一张或多张新旧照片；
- 单图、指定多图或整个批次的用户文字说明；
- 原始语音，以及由 ASR 生成的 final ASR；
- 相册上传和家庭双端互传；
- 第二轮、第三轮继续上传，并在同一家庭和主体范围内检索此前内容；
- 获得单图授权后的人物候选匹配。

输出支持：

- 事件/故事 `StoryUnit`；
- AI 标题、短摘要、时间线和相册成员；
- 人物、时间、地点、事件、场景、主题等可扩展标签；
- `same / different / unknown` 关系、证据来源和冲突；
- `AI 整理 / 可能相关 / 需要确认 / 无法判断` 等产品状态；
- 供相册搜索、访谈问题和独立 `MemoryCandidate` Gate 使用的候选。

姓名、亲属关系、敏感事实和长期 Memory 仍有独立确认门禁。Embedding、模型自报置信度或旧 `0.25/0.55/0.80` 都不能直接充当真实概率，也不能单独决定自动合并。

## 2. 已完成基线：不重复开发

|模块|已有结果|本轮处理|
|---|---|---|
|分类契约与 Guard|Evidence、Job、Assertion、授权 revision、迟到结果、撤权和生命周期契约已存在|只补新接口，不重写|
|真实语义模型|Qwen3.7 Flash 已有服务端调用、Prompt `.16`、真实探索记录|继续使用，先做真实混合链后再做冻结 validation|
|Feature Service|RapidOCR/PP-OCRv5、Chinese-CLIP、YuNet/SFace、SenseVoice/FunASR 已在 VirtAI 真实加载并通过 HTTP smoke|补产品链调用与证据边界|
|远端计算平面|隔离目录、持久下载缓存、不可变 release、Worker pull、健康检查和回滚脚本已存在|补齐缺口后更新 release|
|Worker 主链|图片下载、Feature Service、Stage A、VLM、组织与回传已串联|修复授权顺序、人物召回和历史召回|
|本地页面|多图确定性页面和单图真实 Qwen 页面均存在|合成一个真实混合 T1 页面|
|正式评测|20 个 submission 的固定矩阵、51 次 Provider 单元和 4 个确定性单元已冻结|修复 evaluator 后执行，不改变 validation 真值|
|交付工具|ZIP、manifest、SHA-256、secret scan 和完整性检查已有脚本|完成后升级交付版本|

这些结果只证明组件和工程链已有基础，不代表完整产品链已经通过，也不代表真实用户准确率。

## 3. 当前必须关闭的缺口

### P0-1 人物授权顺序

当前 Worker 可能先调用人脸特征，再读取 `personConsentRef`。必须改为：

1. 先获取并校验 execution context；
2. 得到逐图片、当前 revision 有效的授权 Evidence ID；
3. 只对已授权图片调用 face embedding；
4. 未授权图片仍正常完成其他分类；
5. 授权撤回或版本变化后拒收迟到的人物结果。

### P0-2 人物特征没有进入候选召回

Feature Service 已生成人脸向量，但 Worker 还没有形成 `face_embedding_topk`。必须补充：

- 人脸向量标准化与相似候选排序；
- 候选保留匿名 face ID、框、模型 revision 和来源；
- 仅作为“可能同一人物”的候选，不自动写姓名或亲属关系；
- 与 VLM 的人物/全身框语义分开，禁止把 face box 当成完整 person box。

### P0-3 只有批内 Top-K，没有跨轮历史召回

必须增加稳定的 `HistoricalRetrievalAdapter` 契约：

- 查询前按 `householdId + subjectId + active lifecycle + authorizationRevision` 过滤；
- 支持 image/text embedding、face embedding、近重复和已确认参考多路候选；
- 第一轮写入本地参考索引，第二轮能够检索第一轮；
- 历史候选必须连同当前授权可读的历史投影、观察或受控资产引用进入 Stage A，不能只返回会被当前目录过滤掉的旧 Evidence ID；
- 算法包提供文件型参考实现，全栈工程师可映射到 PostgreSQL + pgvector；
- 产品数据库和对象存储仍由全栈负责，算法不能绕过后端直接写业务库。

### P1-1 原始语音没有进入分类前置链

必须在本地 T1 加入独立 ASR 前置 Job：

- 原始音频先保存为受控临时资产，由 reference control plane 租赁给 Worker；
- Worker 在与 Feature Service 同机的可信边界调用 `/internal/v1/features/asr`，浏览器和普通产品 Next 进程不能直连 loopback 服务；
- 成功后生成带 producer/model revision 的 final ASR Evidence；
- ASR 失败时保留音频和明确错误，不虚构转写；
- 有 final ASR 时不重复转写。

当前真实 ASR adapter 只接受 16-bit uncompressed PCM WAV。T1 首版显式校验并支持这一格式；WebM/Opus 或损坏文件返回 `UNSUPPORTED_MEDIA`。如后续需要浏览器直接录音，再由全栈在可信服务端加入受限转码，不把静默转码混进分类算法。

### P1-2 两个页面没有形成真实混合体验

必须先提供文件型 reference control plane，再提供统一 T1 页面。control plane 至少实现 lease、heartbeat、execution-context、complete、fail、cancel-ack 和受控 artifact 下载/上传；它只用于 T1 证明 Worker 契约，全栈在 T2 替换为产品数据库、对象存储和队列。

统一页面复用现有页面和 API，不重写 UI：

- 单图与多图；
- 文本/ASR 的单图、指定多图和批次绑定；
- 本地 Feature Service + 历史召回 + Qwen；
- 多轮上传与持久化历史；
- 人物授权开关和匿名人物候选；
- processing、partial、failed、cancelled 等状态；
- 标题、摘要、标签、分组理由、证据来源和错误阶段可见。

### P1-3 evaluator 语义需在正式 validation 前修正

只修正评测工具对冻结定义的实现，不改 validation 真值：

- taxonomy 映射；
- 相对时间别名；
- 上传/扫描时间不能冒充事件时间；
- OCR 证据注入；
- face box 与 person box 分离；
- 零图 text-only / ASR-only 的确定性评估保持独立分母。

## 4. 严格执行顺序与 Gate

### Phase 0：冻结基线与本计划

1. 确认工作树、当前 HEAD、已有运行证据和额度账本；
2. 写入本文和执行日志；
3. 单独提交计划，不混入实现。

Gate：计划可追溯到具体文件、测试和完成标准；历史失败与旧版本仍可找到。

### Phase 1：先修人物隐私与 Worker 正确性

预计修改：

- `deploy/classification-worker/runtime/pipeline-processor.mjs`
- `deploy/classification-worker/runtime/worker-runtime.mjs`
- `deploy/classification-worker/tests/worker-runtime.test.mjs`

执行：

1. execution context 与 Guard 前移；
2. 将获授权的 image Evidence ID 显式传给 feature processor；
3. 未授权图片不调用 face endpoint；
4. 为授权缺失、撤回、版本变化和部分成功补聚焦测试。

Gate：测试能证明“授权检查发生在人脸计算之前”；其他维度在未授权人物匹配时仍可完成。

### Phase 2：人物 Top-K 与历史检索

预计新增或修改：

- Worker derived-feature 构建；
- 历史检索 JSON Schema/TypeScript 类型；
- 文件型参考索引与测试；
- Stage A retrieval hints 组装。

执行：

1. 生成批内 `face_embedding_topk`；
2. 定义历史索引 upsert/query/delete/revoke 契约；
3. 定义历史候选的授权投影/观察/资产引用，并扩展 Stage A 接收边界；
4. 合并批内和历史候选并去重；
5. 证明跨家庭、跨主体、已撤回 Evidence 不可被召回；
6. 证明第二轮能找到第一轮已确认参考，且不会自动写姓名。

Gate：固定夹具通过跨轮检索、双家庭隔离、多主体隔离、撤回过滤和模型版本边界。

### Phase 3：reference control plane、ASR 前置 Job 与统一真实 T1 页面

执行：

1. 实现文件型 reference control plane 六个 Worker 接口、租约 fence 和 artifact adapter；
2. 增加 ASR pre-job 的大小、PCM WAV 格式、超时和错误边界；
3. 由 Worker 调用本机 ASR，并将成功输出转成 final ASR Evidence；
4. 新增统一真实混合 route，通过 reference control plane 驱动真实 Worker、历史索引和 Stage A；
5. 更新页面支持多图、多轮、语音、文本绑定和人物授权；
6. 保留原页面作为回退入口。

Gate：本地页面能完成四轮连续上传，且结果证明来自 Worker pipeline 而不是 Next 进程直跑的空 `derivedFeatures` Stage A；至少覆盖图片、图文、图文语音、纯文本或纯语音中的代表组合；刷新后会话和历史仍能读取。

### Phase 4：真实混合链探索

先运行零付费 preflight，再执行真实调用。当前总授权硬上限为 150 次 / ¥25，所有页面和批次调用共享同一账本；自动重试固定为 0。

执行顺序：

1. 1 个端到端 canary：真实图片 → OCR/embedding/人物候选/ASR（如有）→ 历史召回 → Qwen → StoryUnit；
2. 小批探索覆盖单图、多图、跨轮、冲突、模糊图、人物、无地点/无时间、纯文本和 final ASR；
3. 按错误阶段归因：输入、ASR、OCR、embedding、召回、VLM、Schema、Guard、组织、持久化、展示；
4. 只修共因，修复后提升版本并新建 run，不覆盖旧 run；
5. 页面人工检查标题、摘要、分组和证据是否符合产品目标。

停止条件：授权/预算/model/scope 错误立即停；单例错误记录后继续独立案例；不得为了某个 validation 样本修改真值。

Gate：至少一条完整真实混合链和一条跨轮链有可审计成功证据；所有失败有准确阶段和错误码。

### Phase 5：冻结版本与正式 validation

冻结：Git SHA、Prompt、Guard、taxonomy、adapter、Feature Service 模型 revision、数据集 digest、truth、运行参数和额度。

执行：

- exploration：冻结矩阵中的 31 次 Provider 调用；
- validation：独立 20 次 Provider 调用；
- deterministic：4 个零图单元独立评估；
- 生命周期、撤权、迟到结果、幂等和隔离回归；
- 记录成本、请求数、p50/p95、失败切片和未运行项。

Gate：只有实际执行的分母可报告。合成数据结果称为“固定测试集功能验证”，不得称为真实家庭准确率或真实用户效果。

### Phase 6：T1 产品人工验收

由产品负责人在统一页面检查代表场景：

1. 单张老照片 + 文字；
2. 多图同一事件；
3. 多图不同事件；
4. 批次说明；
5. 指定图片说明；
6. 原始语音生成 final ASR；
7. 文字与图片冲突；
8. 获授权匿名人物组与后续跨轮归纳；
9. 无授权时不做人脸计算；
10. 撤回、删除、取消和部分失败。

Gate：无 P0；P1 必须有明确的修复或降级方案。体验通过不等于 T3 真实老人效果验证。

### Phase 7：文档、发布候选与 ZIP

更新：

- 完整算法架构与数据流；
- 全栈接入指南、HTTP/Worker/检索/ASR 契约；
- VirtAI 部署、健康检查、升级和回滚；
- 环境变量、模型来源、license、revision 和 SHA；
- 实际验证报告、错误清单、已知限制和人工验收步骤；
- PRD traceability 与职责边界。

最终 ZIP 必须：

- 包含代码、Schema、示例、测试、部署脚本、运行报告和说明；
- 包含 `PACKAGE_METADATA.json`、`MANIFEST.sha256` 和 ZIP SHA-256；
- 通过 secret scan、ZIP integrity、分类回归、TypeScript typecheck、Feature Service 测试和 delivery check；
- 不含 API key、SSH 私钥、模型权重、真实用户媒体、运行临时文件或产品数据库；
- 标记为 T0/T1 internal release candidate，不冒充生产发布。

Gate：在新的干净输出目录生成唯一 ZIP；全栈工程师按 README 能启动参考服务、调用接口、理解持久化职责和回滚方式。

## 5. 提交与回退边界

按以下小提交推进，每个提交先跑聚焦检查：

1. `docs(classification): freeze T1 handoff completion plan`
2. `fix(classification): gate face features before extraction`
3. `feat(classification): add face and historical retrieval candidates`
4. `feat(classification): add ASR pre-stage to T1 lab`
5. `feat(classification): expose multi-round real hybrid lab`
6. `fix(classification): align formal evaluator semantics`
7. `docs(classification): record hybrid validation evidence`
8. `chore(classification): package T1 full-stack candidate`

不得用 `git reset --hard`、覆盖历史运行目录或改写旧失败记录。回退以小提交 revert、上一不可变 release 和 `current` symlink 切换为主。

## 6. T0/T1 完成定义

只有同时满足以下条件，才能向用户说“可以交给全栈工程师进入 T2”：

- 真实 Qwen 与真实 Feature Service 在同一完整主链中执行过；
- 多图、文字、final ASR、原始音频前置 ASR 和跨轮历史均有可复现实例；
- reference control plane 能在进程重启后恢复任务、租约和结果，且全栈替换边界清楚；
- 人物匹配开启时逐图片授权先于计算，输出仍是匿名候选；
- 未授权、撤权、删除、跨家庭、跨主体和迟到结果 fail closed；
- 页面能供产品负责人实际上传、查看、纠正和复测；
- 固定 exploration/validation 与生命周期检查有真实运行报告；
- 全栈职责、接口、版本、错误码、部署和回滚文档齐全；
- 最终 ZIP 通过完整性和密钥扫描。

全栈工程师接手后仍需完成 T2：产品账号鉴权、业务数据库、对象存储、pgvector、队列/outbox、正式监控、产品 UI 接入和内部用户环境部署。算法侧交付的参考索引与文件存储用于证明契约和行为，不能替代产品数据库。

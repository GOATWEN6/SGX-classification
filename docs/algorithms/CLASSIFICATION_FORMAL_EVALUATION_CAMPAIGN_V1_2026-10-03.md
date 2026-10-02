# SGX 自动分类与归纳正式评测 Campaign v1

> 日期：2026-10-03  
> 状态：`frozen_design_pending_machine_manifest`  
> 适用阶段：T0 算法正式评测、T1 全栈接入前 Gate  
> 核心边界：本文冻结评测设计，不等于已经执行真实模型调用，也不授予超出已绑定 approval/pointer 的外部调用权限。

## 1. 目标与非目标

### 1.1 本轮要回答的问题

本轮用 accepted synthetic-v2 媒体和固定真实 Provider，验证以下产品链能否按同一套契约工作：

1. 图片、用户原文和 final ASR 作为相互独立、可追溯的 Evidence 输入；
2. 本地 OCR、image/text embedding、近重复和授权后匿名人物特征提供低成本信号；
3. `qwen3.7-flash-2026-07-15` 完成需要视觉语义的单图抽取和稀疏关系判断；
4. 规则、Guard 和组织器保留来源、冲突、unknown、撤权状态和家庭隔离；
5. 输出 StoryUnit、标题、摘要、时间线和筛选标签，并区分自动整理、局部复核与高风险暂停；
6. 人物能力只输出匿名候选组，不猜姓名、亲属关系，不直接确认身份或写入长期 Memory；
7. 记录每次调用、失败、token、费用、时延、模型/Prompt/规则版本，能复现、审计和回退。

### 1.2 本轮不证明什么

本轮不证明真实家庭照片准确率、真实人脸身份可靠性、真实老人语音 ASR 质量、生产 SLA、商业可用性、用户收益或公开发布就绪。数据中的人物、家庭、事件和关系均为合成真值。OCR、人物和 embedding 结果只用于内部功能验证；姓名、亲属关系、敏感事实、跨端分享和长期 Memory 晋升仍使用独立确认机制。

## 2. 不可变输入与版本

### 2.1 Accepted dataset

- Dataset：`sgx-synthetic-multimodal-testset-v2`
- Release：`sgx-synthetic-multimodal-testset-v2-spec-2.0.0-r1`
- Spec：`2.0.0`
- Accepted dataset root digest：`sha256:2d18d96933f5c85454357eedee45cb185c9ad5eefac6f21e513ce0166ded0f2a`
- Payload tree digest：`sha256:4986b9b2c190baad24811a579edfad250aa94593688dd78f66b8614c9ad13de3`
- Acceptance pointer：`/Users/wenqingzhong/Documents/Codex/2026-09-27/sgx-synthetic-v2-acceptance/outputs/ACCEPTED.json`
- 本地 accepted root：`/Users/wenqingzhong/Documents/Codex/2026-09-27/sgx-synthetic-multimodal-v2/outputs/sgx-synthetic-multimodal-testset-v2`
- Claim boundary：`synthetic_fixture_and_current_offline_integration_only`

任何源媒体、truth、split、原始 manifest 或 accepted sentinel 发生变化，当前矩阵立即失效。正式执行前必须重新校验 accepted digest，不能在 accepted root 内补写 consent、评测结果或临时文件。

### 2.2 算法与模型冻结项

正式 manifest 至少绑定：

- VLM：`qwen3.7-flash-2026-07-15`
- 计划计费系数：输入 `¥1.2 / 1M tokens`、输出 `¥4.8 / 1M tokens`；执行前必须与当日供应商价格和 approval 再绑定，变化则停止而非静默沿用；
- Prompt：`sgx-five-facets.13`
- Stage A validation：`stage-a-validation.2`
- Provider identity：`qwen:qwen3.7-flash-2026-07-15:sgx-five-facets.13:stage-a-validation.2`
- Ingestion contract：`classification-ingestion.2`
- Guard：`classification-lab-guard.1`
- Adapter：`classification-lab-stage-a-composition.1`
- Taxonomy：`sgx-taxonomy.1`
- OCR、embedding、YuNet/SFace、ASR：必须绑定当前 candidate model registry、revision 和 artifact hash；不得只写模型简称。
- 自动重试：`0`
- Campaign 总硬上限：真实 Provider 请求不超过 `150` 次，总费用不超过 `¥25`。

Git SHA、execution profile digest、place-kind policy digest、价格表、地域和 response model ID 也必须进入正式 pointer。本文出现的版本只作为待物化 manifest 的冻结来源；若代码常量不同，必须先停止并生成新版本本文，不能静默替换。

## 3. Campaign 派生与隔离规则

Accepted dataset 是不可变媒体与真值来源，下面的 20 个 submission 是独立的 run-local 评测组合。它们不回写 dataset。

由于 accepted catalog 中没有原生五图且同时满足同一 `householdId + subjectId` 的目录，物化器必须为每个 submission 创建 synthetic evaluation subject，例如 `EVAL-EXP-01`。规则如下：

1. 一个 submission 中的全部源 bundle 必须来自同一个原始 `scopeId/householdId`，禁止跨 household；
2. run-local `subjectId` 只表示该次合成评测的隔离主体，不代表真实人物；
3. 每条派生 Evidence 保留 `sourceBundleId`、原始 `subjectId`、source path、source hash、accepted dataset digest 和 split；
4. 派生 evidence ID、授权 revision、context revision、绑定关系和 matrix manifest 单独计算 canonical digest；
5. 同一源图片在 exploration 的不同 submission 中出现时，必须得到不同的派生 evidence ID；这是上下文消融，不得作为两个独立媒体样本计准确率；
6. Validation 不复用 exploration source group 或 leakage group；base-v1 的 `SGX-SYN-H002` 已包含在同一个 accepted combined dataset 中，仍按 holdout 使用；
7. 正式调用前必须先生成机器可读 manifest、truth ledger、approval 和 pointer，并逐项核对本文件。没有 matrix digest 时不得执行。

这里的“30 张图片”是 30 个 submission image occurrences；其中 exploration 为验证不同上下文会重复使用 `E013/E014/E015`。报告必须同时给出 occurrence 数和唯一 source image 数，不能把重复 occurrence 写成新增独立样本。

## 4. 20 个 submission 精确矩阵

记号：`P`=photo，`T`=user_text，`A`=final ASR；未写全称的 `E###/H###/T###/A###` 均指 `SGX-V2-*`，唯一复用的 base-v1 bundle 明写为 `SGX-SYN-H002`。原始音频只供 ASR 轨道，不直接进入当前分类器。`VLM` 列等于图片 extract 调用数加预登记 event relation 调用数；四个无图 submission 只运行确定性产品评估。

|ID|阶段|产品入口|Household / run-local subject|源 bundle 与本次启用 Evidence|图 / T / A|Event relation|VLM 调用|人物开关|
|---|---|---|---|---|---:|---:|---:|---|
|`EXP-01`|exploration|album_upload|`scope-bamboo / EVAL-EXP-01`|`SGX-V2-E002(P)`|1 / 0 / 0|0|1|开启；逐图 consent|
|`EXP-02`|exploration|album_upload|`scope-river / EVAL-EXP-02`|`E013(P)`, `E014(P)`|2 / 0 / 0|1|3|开启；逐图 consent|
|`EXP-03`|exploration|family_transfer|`scope-river / EVAL-EXP-03`|`E013(P)`, `E015(P)`|2 / 0 / 0|1|3|开启；逐图 consent|
|`EXP-04`|exploration|family_transfer|`scope-river / EVAL-EXP-04`|`E014(P)`, `E015(P)`|2 / 0 / 0|1|3|开启；逐图 consent|
|`EXP-05`|exploration|album_upload|`scope-river / EVAL-EXP-05`|`E003(P,T,A)`, `E004(P)`|2 / 1 / 1|1|3|开启；逐图 consent|
|`EXP-06`|exploration|album_upload|`scope-lantern / EVAL-EXP-06`|`E005(P)`, `E006(P)`|2 / 0 / 0|1|3|开启；逐图 consent|
|`EXP-07`|exploration|album_upload|`scope-bamboo / EVAL-EXP-07`|`E012(P,A)`, `E019(P)`|2 / 0 / 1|1|3|开启；逐图 consent|
|`EXP-08`|exploration|album_upload|`scope-pine / EVAL-EXP-08`|`E007(P)`, `E011(P,T,A)`, `E016(P)`, `E017(P)`, `E018(P)`|5 / 1 / 1|7|12|开启；含匿名人物真值子集|
|`EXP-09`|exploration|family_transfer|`scope-bamboo / EVAL-EXP-09`|`T001(T)`|0 / 1 / 0|0|0 + 1 deterministic|不适用|
|`EXP-10`|exploration|family_transfer|`scope-river / EVAL-EXP-10`|`T002(T)`|0 / 1 / 0|0|0 + 1 deterministic|不适用|
|`EXP-11`|exploration|family_transfer|`scope-pine / EVAL-EXP-11`|`A001(A)`|0 / 0 / 1|0|0 + 1 deterministic|不适用|
|`EXP-12`|exploration|family_transfer|`scope-bamboo / EVAL-EXP-12`|`A002(A)`|0 / 0 / 1|0|0 + 1 deterministic|不适用|
|`VAL-01`|validation|album_upload|`scope-pine / EVAL-VAL-01`|`H001(P,A)`|1 / 0 / 1|0|1|开启；逐图 consent|
|`VAL-02`|validation|album_upload|`scope-pine / EVAL-VAL-02`|`H002(P)`|1 / 0 / 0|0|1|开启；逐图 consent|
|`VAL-03`|validation|album_upload|`scope-lantern / EVAL-VAL-03`|`H003(P,T)`|1 / 1 / 0|0|1|开启；逐图 consent|
|`VAL-04`|validation|album_upload|`scope-lantern / EVAL-VAL-04`|`H005(P,T)`|1 / 1 / 0|0|1|开启；逐图 consent|
|`VAL-05`|validation|album_upload|`scope-lantern / EVAL-VAL-05`|`H007(P,A)`|1 / 0 / 1|0|1|开启；逐图 consent|
|`VAL-06`|validation|album_upload|`scope-pine / EVAL-VAL-06`|`H011(P,A)`|1 / 0 / 1|0|1|开启；逐图 consent|
|`VAL-07`|validation|album_upload|`scope-river / EVAL-VAL-07`|`H012(P,T)`|1 / 1 / 0|0|1|开启；逐图 consent|
|`VAL-08`|validation|album_upload|`scope-bamboo / EVAL-VAL-08`|`SGX-V2-H004(P,T,A)`, `H008(P,T,A)`, `H009(P,T)`, `H010(P,T)`, `SGX-SYN-H002(P,T,A)`|5 / 5 / 3|8|13|开启；含匿名人物真值子集|
|**合计**|||20 submissions|53 Evidence|30 / 12 / 11|21|51 + 4 deterministic|16 个含图 submission 全开启|

矩阵同时满足：单图/两图/五图为 `8/6/2`；纯文字/纯 final ASR 为 `2/2`；`album_upload/family_transfer` 为 `14/6`；exploration 为 12 个 submission、18 张图片、13 个 relation、31 次真实调用和 4 个确定性评估；validation 为 8 个 submission、12 张图片、8 个 relation 和 20 次真实调用。

## 5. Event relation ledger：7 / 11 / 3

这一分母只统计事件/故事关系，不与人物关系混算。每个 pair 只调用一次 relate；同一 pair 不重复充数。

|Relation ID|Submission|Left|Right|Truth|冻结依据|
|---|---|---|---|---|---|
|`R01`|EXP-02|E013|E014|same|同一花园志愿活动，strong lineage|
|`R02`|EXP-03|E013|E015|same|同一花园志愿活动，strong lineage|
|`R03`|EXP-04|E014|E015|same|同一花园志愿活动，strong lineage|
|`R04`|EXP-05|E003|E004|unknown|E003 有工作事件；E004 明确“服装不证明工作”，缺失事件证据|
|`R05`|EXP-06|E005|E006|unknown|纸箱相似；E006 明确“纸箱不证明搬家”|
|`R06`|EXP-07|E012|E019|unknown|E019 只有桌面/注入纸条，不能据此判断事件关系|
|`R07`|EXP-08|E016|E017|same|同一物理旧照的原图与裁切|
|`R08`|EXP-08|E016|E018|same|同一物理旧照的原图与翻拍|
|`R09`|EXP-08|E017|E018|same|同一物理旧照的裁切与翻拍|
|`R10`|EXP-08|E007|E011|different|家庭用餐与搬家时间冲突场景为不同事件|
|`R11`|EXP-08|E007|E016|different|近期家庭用餐与旧自行车照片来源独立|
|`R12`|EXP-08|E011|E017|different|搬家场景与旧照裁切来源独立|
|`R13`|EXP-08|E007|E018|different|家庭用餐与旧照翻拍来源独立|
|`R14`|VAL-08|H008|H009|same|同一趟三日旅行不同日程，strong lineage|
|`R15`|VAL-08|H008|H010|different|H010 是次年独立旅程|
|`R16`|VAL-08|H009|H010|different|H010 是次年独立旅程|
|`R17`|VAL-08|H004|H008|different|1976 家庭聚会与旅行独立|
|`R18`|VAL-08|H004|H009|different|1976 家庭聚会与旅行独立|
|`R19`|VAL-08|H004|H010|different|1976 家庭聚会与次年独立旅行不同|
|`R20`|VAL-08|SGX-SYN-H002|H008|different|结婚纪念日晚餐与山间旅行不同|
|`R21`|VAL-08|SGX-SYN-H002|H010|different|结婚纪念日晚餐与独立旅行不同|

汇总：`same=7`、`different=11`、`unknown=3`。`unknown` 必须保持未合并；不能为了提高自动化比例强制改成 same 或 different。

## 6. 人物匹配：run-local consent 与 truth overlay

### 6.1 为什么必须使用 overlay

Accepted synthetic-v2 的所有原始 manifest 都固定为 `allowPersonMatching=false`，并且原始 truth 没有可自动计分的 face box/face ID。正式评测不得修改这些文件。人物测试由 run-local authorization overlay 开启：

- 16 个含图 submission 均设置 `allowPersonMatching=true`；
- 每个 active image evidence 都必须列入 `personMatchingEvidenceIds`；
- 每张图片都有唯一、非空的 `personConsentRef`，建议格式为 `person-consent:campaign-v1:<submission-id>:<derived-evidence-id>:r1`；
- 通用 `consentRef` 不能替代人物 consent；
- approval、pointer、guard snapshot 和 matrix manifest 中的开关必须一致；
- 少任意一张图片的 consent、存在 foreign evidence ID、或开关关闭却携带 reference/correction 时，必须在 feature/model 调用前失败。

首轮 `references=[]`、`corrections=[]`，只验证匿名候选。后续 reference 必须来自用户确认端点，包含准确 `photoId + faceId + normalized faceBox + photoHash`；correction 必须 authority-bound、allowlisted，且两端均有 consent。

### 6.2 可计分人物真值

正式调用前先在本地运行冻结的 YuNet detector，将 face box 和 detector version 写入 overlay；随后由人工只做匿名 slot 对齐并冻结 overlay digest。模型输出仍只能引用本地 face ID，不能看到或生成真实姓名、亲属关系。

1. `E016/E017/E018`：每张只有一个主要虚构成年人；三组 photo pair 均为 `same`。这是第一优先人物正例。
2. `H008/H009`：同一对匿名虚构老人，对应人物为 `same`；只用“左/右或 face slot”定位，不使用姓名或亲属称谓。
3. `H010`：不同的虚构老人；与 `H008/H009` 的人物候选不得自动合并。
4. `H005/H006/H007`：冻结生成说明为不同成年人，可在 validation 结论锁定后作为单独预登记的 post-validation stress diagnostic；它不进入核心 51 次和本版 Gate，不得用于回调 validation。

目前没有 canonical 的跨图 `person=unknown` pair。不得把 event unknown、画面模糊或“没有人”改写成人物 unknown 真值。若以后需要该分母，应新增并独立接受一组“两张均有人脸，但遮挡/背面/质量使身份关系明确冻结为 unknown”的数据版本。

### 6.3 无人物负例

核心矩阵包含以下无人物图片：

- `E002`：空校园；
- `E006`：仓储纸箱；
- `E019`：桌面纸条；
- `H011`：收音机；
- `H012`：抽屉。

这些案例的 Gate 是 `people=[]` 或没有可接受的人物候选组、没有 person relation、没有姓名/关系推断。它们验证防幻觉，不计作跨图 `person=unknown`。

## 7. 51 + 4 的调用与计费口径

### 7.1 核心分母

- `30` 次 extract：矩阵中的 30 个 image occurrences，每个 occurrence 一次真实 Provider 调用；
- `21` 次 relate：R01–R21，每个 pair 一次真实 Provider 调用；
- 合计 `51` 次真实 Provider 调用；
- `4` 个无图 submission 运行 deterministic text/final-ASR organization，各计一个确定性产品评估单元；
- 总评估单元为 `55`，但真实请求分母仍是 `51`。

一次真实 HTTP 请求只要已经发给 Provider，无论成功、timeout、429、invalid output 或 response truncated，都计入请求、token、费用和固定分母。自动重试为 0。任何定点复测必须使用新 batch ID、单独预登记，并计入 campaign 累计 `150/¥25` 上限，不能覆盖失败记录。

OCR、embedding、face embedding 和 ASR 是本地 feature service 调用，不进入 `51` 次付费 Provider 请求；它们必须在独立组件账本记录调用数、cache hit、时延、CPU/GPU/RAM、模型 revision 和失败。StoryUnit 标题/摘要在当前组织链内生成，不额外预留第三类 VLM 调用；若实现新增独立摘要调用，必须提升 campaign 版本并重新计算分母。

### 7.2 阶段预算

|阶段|真实 Provider|确定性评估|说明|
|---|---:|---:|---|
|Exploration|31|4|允许基于共同失败原因修 Prompt/adapter/Guard；修复必须升版本并新建目录|
|Validation|20|0|打开 holdout 输出后，不得修改本版 truth、Prompt、规则或评分器|
|核心合计|51|4|共享一个累计 campaign ledger|
|全部扩展上限|150|不限制本地确定性检查|所有额外真实请求需单独预登记；总费用上限 ¥25|

## 8. 持久盘与产物目录

远端正式评测只允许使用 SGX 隔离目录：

```text
/gemini/code/sgx-classification/
  shared/
    evaluations/classification-lab/
      datasets/<accepted-dataset-digest>/
      real-batch/campaigns/<campaign-id>/
        campaign-ledger.json
        batches/<batch-id>/
    models/candidates/
    manifests/
    wheelhouse/
    downloads/
    cache/
  releases/<git-sha>/
  current -> releases/<git-sha>
```

- `CLASSIFICATION_LAB_DATA_DIR=/gemini/code/sgx-classification/shared/evaluations/classification-lab`；缺失或指向常规临时目录时 fail closed。
- Dataset、matrix manifest、approval、pointer、truth、raw response、parsed result、usage、费用、latency、product projection、failure taxonomy 和最终报告全部写入持久盘。
- 每个 run 使用全新目录；原失败目录只读保留，禁止 `rm`、覆盖或原地修复。
- `/quota/sgx-classification` 只放由持久 wheelhouse/release 可离线重建的 venv 与生成缓存，不是唯一证据副本。
- 单任务明文输入只暂存在 `/tmp/sgx-classification/jobs/<job-id>`，结束、取消或超时后清理；不得把 `/tmp` 当 campaign ledger。
- 不依赖 `/gemini/output` 可写；不与其他项目目录、模型 cache 或日志混用。
- 密钥只由 secret storage/进程环境提供；不得进入 manifest、日志、raw response、Markdown 或 Git。

## 9. 停止条件与失败隔离

### 9.1 全局停止

出现以下任一情况，停止当前 batch 后续真实请求并冻结现场：

- accepted dataset/matrix/truth/Git/Prompt/model/价格或 approval digest 不匹配；
- approval 过期、未授权、授权 revision 改变或 campaign pointer 绑定不一致；
- household/scope 越界、foreign evidence、人物 consent 缺失；
- campaign 预算不足、超过 `150` 次或 `¥25`、账本锁不确定、已有同 phase validation；
- 持久数据根缺失或不可写、模型实际返回 ID 不符、凭证不可用；
- 无法确认一次请求是否已经发送或计费。此时按最坏情况保留 reservation，人工对账后才能继续。

### 9.2 Case-local failure

`INVALID_OUTPUT`、`OUTPUT_TRUNCATED`、`RESPONSE_LIMIT`、`RATE_LIMITED`、`PROVIDER_UNAVAILABLE`、`PROVIDER_REJECTED`、`TIMEOUT` 只使当前 case 失败；记录错误并继续其他相互独立的 case。失败、not-run 和 needs-review 始终保留在固定分母中。

单例失败不得自动重试。Exploration 只有确认是共同原因时才允许修复；修复后提升 Prompt/adapter/Guard 或 manifest 版本并创建新 run。Validation 失败形成下一版本，不回写本版结论。

## 10. 执行顺序

1. **零调用 preflight**：校验 accepted digest、matrix/truth digest、Git SHA、模型/Prompt/价格、approval/pointer、持久盘、预算、split 和 53 条 Evidence 引用；只检查凭证是否可用，不输出凭证。
2. **授权负测**：缺一个 `personConsentRef`、关闭人物开关但携带 reference/correction、跨 household 三项必须在 feature/VLM 前拒绝，不消耗真实调用。
3. **本地 feature preflight**：OCR、image/text embedding、face detector/embedding、ASR、`/healthz`、`/readyz`、`/version`；保存版本和资源证据。
4. **确定性产品评估**：先运行 EXP-09–EXP-12，证明纯文字/纯 final ASR 不需要调用 VLM。
5. **Exploration 低风险到困难场景**：EXP-01 → EXP-07；确认单图、同事件、相似负例、unknown、冲突和注入都能进入统一契约。
6. **Exploration 五图与人物**：最后运行 EXP-08；验证稀疏 7 pair、E016/E017/E018 匿名人物候选和局部失败隔离。
7. **探索复盘与冻结**：按抽取、OCR、召回、event relation、person candidate、聚类、摘要、Guard、产品策略归因。只修共因；完成后冻结新的 Git/Prompt/adapter/truth/matrix digest。
8. **Validation**：VAL-01–VAL-07 后运行 VAL-08；固定 20 次真实请求，一次打开，不在本版内调参。
9. **只读评分与产品盲审**：先机械 Gate，再由产品负责人盲审 10 个代表 StoryUnit；保存逐项理由，不用总分掩盖严重误合并。
10. **结论与交付**：形成结果报告、失败切片、调用/费用/时延账本和全栈 handoff。任何额外人物压力测试在核心结论冻结后另立 manifest。

## 11. Gate

### 11.1 结构、来源与安全 Gate

- 55 个评估单元中 Schema/Guard 可消费至少 53 个；真实 Provider 与 deterministic 两类账本分开；
- 53 条 Evidence 引用 100% 指向本次 active、授权且 hash 匹配的来源；
- 跨 household 候选、撤回证据复用、晚到结果覆盖、姓名/亲属关系自动确认、敏感事实静默进入 Memory 均为 0；
- 图片、文字、final ASR 中的注入内容改变业务事实为 0；
- 四个冲突案例 `E011`、`E012`、`H003`、`SGX-SYN-H002` 保留双方来源并只触发局部复核；
- 无人物负例不得形成可接受的人物组。

### 11.2 Event relation 与产品 Gate

- 11 个 `different` 严重误合并为 0；
- 7 个 `same` 至少 6 个正确成组；
- 3 个 `unknown` 自动合并为 0；
- 4 个证据不足案例不补造高影响事实；
- 12 个低风险案例至少 9 个无需逐项确认；
- 4 个高风险动作全部暂停；
- 10 个代表 StoryUnit 盲审至少 8 个标题/摘要可直接展示或轻改；
- 标题、摘要、标签和关系的 Evidence refs 100% 有效；用户原文未被覆盖。

### 11.3 人物 Gate

- 16 个含图 submission 的 active image consent 覆盖率为 100%；授权负测全部在模型前拒绝；
- `E016/E017/E018` 的单一匿名人物形成同一候选组；
- `H008/H009` 的对应匿名人物可以形成候选，`H010` 不得被自动并入；
- 所有人物输出保持 `candidate/unconfirmed`，不生成姓名、亲属关系或用户已确认状态；
- 跨 household person candidate 为 0，withdraw/delete 后候选不可再检索；
- 因没有 canonical `person=unknown` pair，本版不报告人物 unknown 准确率。

### 11.4 性能与费用 Gate

- 上传接口 p95 ≤ 2 秒并转后台；单图终态 p50 ≤ 15 秒、p95 ≤ 30 秒；五图 submission p95 ≤ 90 秒；
- 所有真实请求都有 token、费用和 latency；失败请求同样计入；
- campaign 累计请求 ≤ 150、费用 ≤ ¥25、自动重试 0；
- 本地 feature service 单独报告 warm/cold latency、queue wait、cache hit、CPU/GPU/RAM 和临时文件清理；
- 无重复计费、重复 StoryUnit 或 stuck Job。

## 12. 结果判定与 claim 边界

只有以下条件同时满足，才能写“通过 synthetic T0 正式功能 Gate，可交给全栈进入 T1 联调”：

1. accepted、matrix、truth、代码、模型、Prompt 和 approval 的 digest 全部匹配；
2. exploration 与 validation 的固定分母完整，失败没有被删除或替换；
3. 第 11 节所有 hard Gate 通过；
4. 报告明确列出 synthetic、重复 source occurrence、人物 truth 覆盖不足和真实数据分母为 0；
5. 结果目录、账本和回退版本位于持久盘，并能由另一名工程师只读复核。

通过后允许声称：固定合成多模态场景下，真实 Qwen + 本地 feature models + Guard/组织器的分类、稀疏归组、标题摘要、匿名人物候选和授权门禁满足本版内部功能标准。

仍不得声称：真实家庭照片泛化、人脸身份准确率、真实老人 ASR、生产 SLA、公开发布安全或真实用户收益。进入产品后仍需全栈完成对象存储、业务数据库、outbox/lease/CAS、鉴权和相册 UI 联调，再用授权真实数据完成下一阶段验证。

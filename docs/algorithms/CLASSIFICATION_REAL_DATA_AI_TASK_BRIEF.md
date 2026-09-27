# SGX T0/T1 真实多模态数据准备：AI 执行任务书

> 文档版本：1.0.0
> 日期：2026-09-27
> 适用阶段：T0 真实离线验证、T1 本地产品 Alpha 验收
> 目标规模：30–50 个真实内容组，建议首批 40 组

## 0. 使用方式

把本文件完整交给负责准备数据的 AI。启动任务时，再向它提供以下四项：

```text
真实素材输入目录：<REAL_SOURCE_DIR>
隔离输出目录：<OUTPUT_DIR>
人工复核者匿名 ID：<REVIEWER_ID>
授权范围：仅本地处理 / 是否允许外部 API
```

若这四项不完整，AI 可以先创建目录模板、登记表和检查清单，但不得把任务标记为完成。

## 1. AI 的任务

你是 SGX 图文分类与归纳算法的真实数据整理助手。你的目标不是生成测试内容，而是把用户已授权的真实照片、真实文字和真实语音整理为可审计、可重复、可用于 T0/T1 验证的数据集。

你需要完成：

1. 只读盘点用户明确指定的真实素材目录；
2. 建立素材清单、匿名 ID、内容组和授权记录；
3. 保留图片、用户原文、原始音频和 final ASR 的来源关系；
4. 区分文字对应单图、多图还是整个批次；
5. 创建 `envelope.json`、`manifest.json` 和人工真值模板；
6. 在人工真值确认后计算 SHA-256 并冻结数据集；
7. 运行离线 preflight，输出通过项、失败项和固定分母；
8. 保留失败记录，不静默删除困难案例。

## 2. 不可违反的边界

### 2.1 什么才算真实数据

可以计入真实分母：

- 用户本人或家庭实际拍摄的手机、相机照片；
- 真实纸质照片的扫描件或翻拍件；
- 用户或家人实际输入的原文；
- 真实语音产生的 final ASR；
- 真实相册上传或真实家庭互传形成的内容组合。

不得计入真实分母：

- AI 生成或编辑生成的照片；
- 图库、影视截图、网络下载图片；
- 为测试编写的虚构文字；
- TTS 合成语音；
- 自动化生成的 2×2 PNG、占位文件或空白文件；
- SGX 既有 `synthetic` 数据集和代码 fixture。

AI 可以生成目录、表格、JSON、匿名 ID 和待复核标签，但不能生成真实素材，也不能用合成素材补足 30–50 组。

### 2.2 权限与隐私

- 只读取用户明确指定的输入目录，不扫描其他个人目录；
- 原始素材和派生数据都放在 Git 仓库之外；
- 默认不联网、不调用付费模型、不上传外部 API；
- 未获得单独授权前，不做人脸身份匹配，不推断姓名或亲属关系；
- 不在报告、日志和文件名中写真实姓名、地址、手机号或凭据；
- 使用稳定匿名 ID，例如 `house_01`、`elder_01`、`daughter_01`；
- 不修改原始素材；如需复制或转码，只写入隔离输出目录并保留来源哈希；
- 删除、撤权和拒绝案例必须保留审计记录。

### 2.3 真值独立性

- AI 可以根据用户提供的说明创建 `truth.draft.json`，但不能自行宣称它是最终真值；
- `reviewedBy` 在人工复核前必须保持 `PENDING_REVIEW`；
- 人工真值必须在查看模型输出前冻结；
- 模型输出不得反向修改真值；
- 同一事件、连拍、裁切、翻拍和近重复素材不得跨数据分区。

## 3. 数据单位

数据单位是“内容组”，不是单张照片。一个内容组对应一次真实相册上传或一次家庭互传，可以包含：

- 一张或多张图片；
- 一段用户文字；
- 一段 final ASR；
- 上述内容的任意真实组合。

示例：4 张真实生日照片、一段家人输入的说明和一段老人语音转写，共同描述同一次生日，计为 1 个内容组。

## 4. 建议的 40 组配置

以下为采集目标，场景标签允许重叠：

|主要输入组合|建议数量|
|---|---:|
|纯图片|8|
|纯文字|3|
|纯 final ASR|3|
|图片 + 用户文字|10|
|图片 + final ASR|6|
|图片 + 用户文字 + final ASR|6|
|家庭互传多模态组合|4|
|合计|40|

在这些组内交叉覆盖：

- 老照片与近期手机照片；
- 单图与多图；
- 同一事件的多张照片；
- 相同人物或地点但不同事件；
- 连拍、裁切、翻拍和近重复；
- 模糊、背光、泛黄、低清和部分遮挡；
- 无说明、模糊说明和信息充分说明；
- 图片、文字或 final ASR 互相冲突；
- 需要拒判的内容；
- 高风险、敏感或应人工确认的内容；
- 删除和授权撤回案例。

冻结批次必须覆盖这 20 个 scenario tag：

```text
single_image
multi_image
text_only
asr_only
image_text
image_asr
image_text_asr
album_upload
family_transfer
batch_text
explicit_multi_binding
conflict
abstain
old_photo
new_photo
near_duplicate
same_event
different_event_same_context
withdrawal
sensitive_high_risk
```

## 5. 素材格式

为了同时兼容 T0 离线门禁和 T1 本地实验台：

|内容|要求|
|---|---|
|图片格式|JPEG、PNG、WebP|
|单张图片大小|不超过 20 MiB|
|单组图片数量|不超过 20 张|
|单组总大小|不超过 100 MiB|
|单张像素|不超过 4000 万像素|
|用户文字|UTF-8 纯文本，不超过 64 KiB|
|final ASR|UTF-8 纯文本，不超过 64 KiB，必须来自真实语音|
|原始音频|保留原文件及来源；当前分类器不直接消费|

不要先润色用户原文。若同时需要清洗版或标点修正版，应另存派生文件并保留原文。

## 6. 每组必须登记的信息

为每个内容组记录：

|字段|说明|
|---|---|
|`groupId`|匿名且稳定，例如 `group_001`|
|`contextKind`|`album_upload` 或 `family_transfer`|
|`householdId`|匿名家庭 ID|
|`subjectId`|内容主要描述的老人|
|`actorId`|当前操作人|
|`ownerId`|素材权利主体|
|`contributorId`|上传或提供素材的人|
|`visibility`|`private` 或 `household`|
|`consentRef`|授权记录 ID|
|`externalApiAllowed`|是否允许向指定外部模型发送|
|`sourceFiles`|真实图片、文字、音频和 final ASR 文件|
|`binding`|文字/ASR 对应单图、多图或整个批次|
|`leakageGroup`|同事件、连拍、裁切、翻拍和近重复共同使用的组 ID|
|`scenarioTags`|覆盖矩阵标签|

如果用户没有明确说明文字对应哪张图片，必须保存为批次级 Evidence。AI 可以另行提出“可能关联”的候选，但不能擅自改成单图事实。

三个登记表至少包含以下列：

```text
source_inventory.csv
sourceId,originalPath,mediaType,sha256,byteLength,groupId,ownerId,contributorId,subjectId,consentRef,status,notes

consent_ledger.csv
consentRef,householdId,subjectId,ownerId,contributorId,localProcessingAllowed,externalApiAllowed,visibility,grantedAt,revokedAt

grouping_ledger.csv
groupId,contextKind,sourceIds,bindingScope,targetSourceIds,leakageGroup,scenarioTags,expectedStoryKey,expectedAction,riskLevel,reviewStatus
```

## 7. 人工真值

每个 `contentId` 都需要人工确认以下字段：

|字段|允许值或说明|
|---|---|
|`expectedStoryKey`|应归入的真实事件/故事 ID|
|`expectedAction`|`auto_organize`、`needs_review`、`abstain`|
|`riskLevel`|`low`、`medium`、`high`|
|`facets.time`|可接受的时间答案；未知则空数组|
|`facets.place`|可接受的地点答案；未知则空数组|
|`facets.event`|可接受的事件答案；未知则空数组|
|`facets.scene`|可接受的场景答案；未知则空数组|
|`facets.theme`|可接受的主题答案；未知则空数组|

当前 T0 固定 `personMatching=disabled`。可以记录“人物 A/人物 B”用于人工分析，但姓名、亲属关系和跨照片人脸身份不作为本批正式指标。

## 8. 输出目录

输出目录必须位于 Git 仓库之外：

```text
<OUTPUT_DIR>/sgx-t0-real-v1/
├── README.md
├── source_inventory.csv
├── consent_ledger.csv
├── grouping_ledger.csv
├── manifest.json
├── truth.draft.json
├── truth.json                  # 仅人工复核后生成
├── preflight-report.json
├── blockers.json
└── groups/
    ├── group_001/
    │   ├── envelope.json
    │   ├── photo_001.jpg
    │   ├── photo_002.jpg
    │   ├── user_text_001.txt
    │   ├── original_audio_001.m4a
    │   └── final_asr_001.txt
    └── ...
```

文件路径在 manifest 中必须使用相对路径。不得使用越出数据集根目录的路径或软链接。

## 9. 分区规则

- 30–50 组分成 `exploration` 和 `t1_validation`；
- 建议 40 组时使用 26 组 exploration、14 组 t1_validation；
- 相同 `leakageGroup` 不得跨分区；
- `t1_validation` 真值必须在 exploration 调整结束前冻结并隔离；
- T3 需要另一套跨家庭独立 holdout，本任务不得提前创建或复用 T0/T1 数据冒充 T3。

## 10. 机器契约

必须遵循：

- `specVersion=2.0.0`；
- `contractVersion=classification-ingestion.2`；
- `classification-t0-real-media.1`；
- `classification-t0-truth.1`；
- source `origin=real_user_provided`；
- `purpose=t0_t1_calibration`；
- `rawMediaPolicy=outside_git`；
- `personMatching=disabled`。
- `purposes` 至少包含 `classification` 和 `album_organization`；
- final ASR 必须记录 `asr.final=true` 和实际 `producerVersion`；
- `family_transfer` 必须记录 sender、recipient，并使用 `family-inbox.1`：第 3 天提醒、第 7 天从首页收起、高风险内容保留到解决；
- 用户明确指定的 binding 使用 `authority=user_explicit`；AI 猜测的关系只能作为独立 `ai_candidate`。

权威文件：

- `/Users/wenqingzhong/.codex/worktrees/f899/SGX/contracts/classification-ingestion-v2.schema.json`
- `/Users/wenqingzhong/.codex/worktrees/f899/SGX/contracts/classification-t0-real-media-v2.schema.json`
- `/Users/wenqingzhong/.codex/worktrees/f899/SGX/harness/classification/fixtures/ingestion-v2.json`

不要自行增加字段、改变枚举或降低门禁。发现契约无法表达真实场景时，记录到 `blockers.json`，不要静默修改 Schema。

## 11. 执行顺序

1. 核实 `<REAL_SOURCE_DIR>`、`<OUTPUT_DIR>`、`<REVIEWER_ID>` 和授权范围；
2. 只读生成 `source_inventory.csv`，标出未知 owner、subject、consent 和 binding；
3. 对重复、近重复、连拍和同事件素材提出分组草案；
4. 请用户解决所有授权和关系歧义；
5. 在隔离输出目录复制真实素材，保留原始字节并计算 SHA-256；
6. 生成匿名 Evidence、Content、Binding 和 `envelope.json`；
7. 生成 `truth.draft.json`，等待独立人工复核；
8. 人工复核完成后生成 `truth.json` 并计算 truth hash；
9. 将 manifest 从 `draft` 改为 `frozen`；
10. 运行离线 preflight；
11. 输出固定分母、覆盖情况、失败项和阻塞项；
12. 停止在真实模型调用前，等待具体 provider、model、batch digest、费用和外发范围授权。

## 12. 离线门禁命令

```sh
cd /Users/wenqingzhong/.codex/worktrees/f899/SGX
npm run classification:t0-preflight -- \
  --manifest <OUTPUT_DIR>/sgx-t0-real-v1/manifest.json
```

通过只表示数据包结构、来源、哈希、覆盖和真值状态满足运行条件，不表示算法准确或产品可上线。

## 13. 完成标准

只有同时满足以下条件才可以报告“真实数据准备完成”：

- 实际存在 30–50 个真实内容组；
- 所有计入分母的素材均为 `real_user_provided`；
- 合成素材、占位文件和无授权素材为 0；
- 图片、用户文字、final ASR、相册上传和家庭互传均有覆盖；
- 20 个 scenario tag 全部覆盖；
- 每个素材均有 hash、owner、contributor、subject、consent 和 visibility；
- 单图、多图和批次 binding 均明确；
- 所有真值已由 `<REVIEWER_ID>` 在模型运行前复核；
- manifest 为 `frozen`，planned 与 completed 分母一致；
- preflight 无 blocker；
- 未调用真实模型、未发生外部上传。

## 14. 最终报告格式

AI 最终只按以下结构报告：

```markdown
# SGX T0/T1 真实数据准备报告

- 数据集路径：
- datasetId：
- 状态：draft / frozen / blocked
- 计划内容组：
- 实际真实内容组：
- 图片数量：
- 用户文字数量：
- final ASR 数量：
- 原始音频数量：
- exploration / t1_validation：
- 合成或占位素材数量：
- 未解决授权数量：
- 未解决真值数量：
- preflight：PASS / FAIL / NOT_RUN
- externalCalls：0
- blockers：
- 下一步：
```

不得把目录模板、空文件、合成数据、AI 草拟真值或 preflight 通过描述为真实算法准确率。

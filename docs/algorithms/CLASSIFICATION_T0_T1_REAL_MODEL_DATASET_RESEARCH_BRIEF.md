# SGX 分类与归纳：真实模型 T0/T1 启动与公开数据集调研任务书

> 日期：2026-09-28  
> 当前真实用户数据：0 组  
> 当前可用合成夹具：40 组 `sgx-t0-photorealistic-synthetic-v3`  
> 目标：先验证真实模型与算法链，再逐步补充真实摄影分布和授权家庭数据

## 1. 先区分三种“真实”

|层级|含义|当前能否开始|能支持的结论|
|---|---|---|---|
|真实模型 + 合成场景|Qwen/GLM 真实 API 处理照片感合成数据|修复真值与 adapter 后可以|模型兼容、Prompt、规则、成本、时延和失败恢复|
|真实摄影 + 公开许可|人类实际拍摄、许可可核验的公开图片|需要先调研和整理|真实成像噪声、老照片、多人、场景和拒判的 T0 补充验证|
|真实家庭产品数据|本人或家庭授权的真实照片、原文、语音和关系|当前没有|T1 真实产品适用性、家庭关系、长期参考和真实交互|

AI 合成图片可以模拟产品场景，但不能成为“真实摄影”或“真实家庭数据”。公开照片可以补足真实视觉分布，但不能自动提供可信亲属关系、用户意图、授权撤回、真实 ASR 和长期 Memory 真值。

## 2. 推荐的推进顺序

### Track A：立即启动真实模型 T0-S

目标是用现有 40 组合成夹具调用真实模型，不等待公开数据集。

开始付费调用前必须完成：

1. 修正并独立复核 v3 真值，尤其是 `g011/g012/g021/g025/g029` 的时间冲突和不可见证据；
2. 冻结新的 dataset digest、truth digest 和 acceptance，保留原失败记录；
3. 实现 `synthetic-v3 -> classification-ingestion.2 / Stage A eval` 可执行 adapter；
4. 先用 deterministic/Mock 完整跑通 40 组；
5. 固定 Provider、模型快照、Prompt、26 组 exploration、14 组 validation、请求上限、费用上限、0 自动重试和停止条件；
6. exploration 用于定位问题；修复后冻结 Prompt、规则和评分器，再运行 validation；
7. validation 运行后不再根据其输出调参。

建议继续使用已经完成兼容性探针的 `qwen3.7-flash-2026-07-15` 作为第一基线。人物身份匹配继续关闭。真实调用必须使用服务端或本地 secret storage，不把密钥写入聊天、Git、数据集或报告。

### Track B：准备公开许可真实摄影集 T0-P

目标不是寻找“带完整家庭关系真值的大数据库”，而是形成 30 个可审计的真实摄影内容组，验证合成到真实照片之间的 domain shift。

建议规模：

- 30 个内容组，18 组 exploration、12 组 validation；
- 60–100 张真实摄影图片；
- 单组 1–8 张，包含同事件多图和不同事件相似场景；
- 不做人脸身份匹配，不把公开人物姓名或亲属关系作为真值；
- 原始公开 caption 只有在许可覆盖且来源可核验时才能保存；
- 研究人员补写的说明必须标成 `researcher_annotation`；AI 生成说明必须标成 `synthetic_text`，两者都不能冒充真实用户原文；
- 公开数据通常没有真实家庭语音，因此不能计入真实 final ASR 分母。

### Track C：本人/家庭授权数据 T0-R 与 T1

这是完整 T1 产品测试无法绕过的部分。正式目标仍为 30–50 个真实内容组；第一轮可以先用 10–15 组做安全 smoke，确认目录、授权、真值和外发流程，再扩展到正式分母。

真实组至少覆盖：相册上传、家庭互传、单图、多图、用户原文、真实 final ASR、老照片、新照片、同事件、近重复、冲突、拒判、撤权和高风险确认。详细格式沿用 [真实数据 AI 任务书](CLASSIFICATION_REAL_DATA_AI_TASK_BRIEF.md)。

## 3. 公开数据集调研的准入标准

只有同时满足以下条件的来源才进入候选：

1. **来源明确**：官方数据集、博物馆/档案馆、Wikimedia Commons、带许可过滤的官方 API；
2. **许可逐项可核验**：保存数据集条款和每张图片的 license/provenance；
3. **允许当前用途**：至少允许本地研发测试；若未来与商业产品相关，优先 CC0、Public Domain、CC BY；
4. **下载方式合规**：官方 archive、API 或明确下载入口，不绕过登录、robots、限流或访问控制；
5. **真实摄影**：排除 AI 图、插画、影视截图、网页截图和来源不明转载；
6. **可留证**：能保存原始 URL、作者、许可、抓取日期、文件哈希和条款快照；
7. **隐私可控**：首批排除敏感场景和可识别未成年人；不推断人物身份、疾病、财务或亲属关系；
8. **可分区**：同一事件、连拍、裁切、翻拍和近重复能够归入同一个 `leakageGroup`。

以下任一情况直接淘汰：

- Google/Bing 图片结果或社交媒体随机抓图；
- 只有“网上公开”但没有明确许可；
- `NonCommercial`、仅学术用途或禁止再分发，却计划用于商业产品测试；
- 数据集许可与图片版权分离，但无法逐图核验；
- 条款禁止自动下载、机器学习、计算机视觉或衍生处理；
- 包含人脸，但来源、人格权或隐私边界无法解释；
- 必须用公开文件名、caption 或 metadata 暴露真实姓名和详细地址。

## 4. 优先调研来源

|优先级|来源|适合补什么|关键限制|
|---|---|---|---|
|P1|Wikimedia Commons / GLAM 档案|历史照片、家庭生活、工作、城市、旅行、老照片扫描|逐文件核对 license、作者、人格权和 attribution；不做热链爬取|
|P1|Flickr API 的 CC 许可筛选|手机/相机真实照片、事件多图、日期和 caption 候选|必须用官方 API、许可 ID 过滤并逐图复核；公开不等于任意使用|
|P2|Open Images V7|多人、物件、场景、图像质量与视觉关系|官方说明图片列为 CC BY 2.0，但明确要求使用者自行验证每张图片的许可|
|Reject|Families in the Wild (FIW)|看似符合家庭与亲属关系|官方条款限定非商业研究/教育且禁止再分发，不进入 SGX 产品测试集|

官方许可入口：

- Wikimedia Commons reuse：<https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/licenses>
- Flickr `flickr.photos.search`：<https://www.flickr.com/services/api/flickr.photos.search.htm>
- Open Images V7：<https://storage.googleapis.com/openimages/web/factsfigures_v7.html>
- FIW license：<https://github.com/visionjo/fiw>

## 5. 场景覆盖要求

公开真实摄影集至少覆盖以下类别，每类可重叠：

|类别|最低组数|
|---|---:|
|家庭/朋友室内聚会|4|
|生日、婚礼、毕业或庆典|4|
|旅行、城市、景点|4|
|工作、退休、兴趣或社区活动|4|
|日常生活、做饭、养花、散步|4|
|老照片、扫描、翻拍、泛黄|4|
|风景、物件或无人照片|3|
|模糊、背光、遮挡、低清、裁切|5|
|同一事件多图/近重复|5|
|相同人物或地点但不同事件|3|
|应拒判或需要人工确认|至少 4|

必须记录哪些类别来自视觉可见事实，哪些只是来源 caption。模型不能根据“看起来像一家人”得出亲属关系。

## 6. 调研结果表

每个候选数据源填写一行；许可不清楚时状态只能是 `HOLD`：

```text
datasetName
officialUrl
provider
versionOrSnapshotDate
downloadMethod
datasetLicense
imageLicensePolicy
commercialUseAllowed
derivativesAllowed
redistributionAllowed
mlOrAutomatedProcessingRestriction
perImageLicenseVerifiable
attributionRequired
peopleOrFaceContent
minorRisk
personalityRightsNotes
imageCountAvailable
sameEventGroupingAvailable
captionAvailable
timeMetadataAvailable
placeMetadataAvailable
oldPhotoCoverage
chineseScenarioCoverage
recommendedUse
decision=ACCEPT|HOLD|REJECT
decisionReason
```

对拟采用的每张图片再建立 `asset_ledger.csv`：

```text
assetId,datasetName,sourcePage,downloadUrl,creator,license,licenseUrl,downloadedAt,sha256,byteLength,mimeType,width,height,captionSource,scenarioTags,leakageGroup,privacyNotes,decision
```

## 7. 调研完成标准

调研不是收集链接。只有以下全部完成，才能交给算法侧生成 T0-P 数据包：

- 至少比较 5 个来源，其中至少 2 个进入 `ACCEPT`；
- 形成 30 组、60–100 张的候选清单；
- 100% 图片有可核验的逐项 provenance 和许可；
- 没有来源不明图片、随机搜索下载、AI 图片或重复泄漏；
- 每个候选组有 `scenarioTags`、`leakageGroup` 和使用限制；
- 明确哪些字段是真实来源 metadata，哪些是人工标注或 AI 合成；
- 单独列出未成年人、人格权、署名、ShareAlike、NonCommercial 等风险；
- 输出 `ACCEPT/HOLD/REJECT` 决策，不自动下载 HOLD/REJECT 项；
- 由项目负责人确认最终来源后，才下载并转换成 SGX manifest。

## 8. 进入 T0/T1 的 Gate

### T0-S：真实模型 + 合成素材

- v3 真值独立验收通过；
- adapter 和 40 组 Mock dry run 通过；
- exploration/validation、模型、Prompt、digest、预算和停止条件冻结；
- 真实 API 输出严格通过 Schema、Evidence 引用和授权版本校验。

### T0-P：真实模型 + 公开许可真实摄影

- 公开数据调研完成并通过许可审核；
- 30 组 manifest/truth 独立冻结；
- 真实照片只评价可由当前证据支持的视觉、事件、场景、拒判和分组；
- 不评价真实亲属关系、真实用户意图、真实 ASR 或长期 Memory。

### T1：本地产品 Alpha

- 真实 Stage A Provider 接入 `/classification-lab`，浏览器不接触密钥；
- 上传、进度、错误、结果、纠错、删除和撤权可在本地页面完整操作；
- 至少 10–15 组本人/家庭授权 smoke 无 P0 安全问题；
- 正式 30–50 组真实内容完成固定分母验收；
- 高风险事实、具体身份、亲属关系和长期 Memory 仍经过独立确认 Gate。

达到 T0-S 只能说明真实模型链在合成场景下可工作；达到 T0-P 才能讨论真实摄影 domain shift；达到 T1 才能讨论本地产品对真实家庭素材的适用性。

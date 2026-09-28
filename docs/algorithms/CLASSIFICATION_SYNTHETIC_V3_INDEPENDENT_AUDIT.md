# SGX 合成多模态 v3 独立可用性审计

> 审计日期：2026-09-28  
> 数据集：`sgx-t0-photorealistic-synthetic-v3`  
> 数据集绝对路径：`/Users/wenqingzhong/Documents/Codex/2026-09-27/sgx-real-data-preparation/outputs/sgx-t0-photorealistic-synthetic-v3`

## 1. 结论

本数据包获得两个不同结论：

- **合成工程夹具：条件通过。** 文件真实存在，媒体可读取，内部清单、哈希、分区、组合和场景索引一致，可以继续用于输入处理、绑定、冲突、拒判、撤权和风险路由的合成 dry run。
- **完整产品测试：不通过。** 它不能替代已经冻结的 T0/T1 真实数据要求，也不能直接进入现有 SGX Stage A、T0 preflight 或浏览器实验台。当前不得据此启动正式准确率验收、跨家庭泛化验收或产品效果验收。

这不是对素材“完全没用”的否定。正确用法是先补独立真值审查和可执行 adapter，把它用于合成探索；真实产品结论仍需要 30–50 组已授权真实内容组。

## 2. 独立复核到的事实

### 2.1 文件、媒体和哈希

|项目|独立结果|
|---|---:|
|内容组目录|40|
|exploration / t1_validation|26 / 14|
|图片|39 个 JPEG|
|用户原文|25 份 UTF-8 文本|
|final ASR|16 份 UTF-8 文本|
|音频参考|16 个 M4A|
|实际素材文件|96|
|校验清单条目|198|
|清单之外未登记文件|0|
|软链接|0|
|SHA-256 复算|198/198 通过|
|失败 / pending|0 / 0|

关键摘要：

- `checksums/SHA256SUMS` SHA-256：`ada5bbd22e744d9fc7ce5ab3d7289b8d83cc29fcc3ac29bfe0a6e18fc1dea429`
- `manifest.json` SHA-256：`a1f9d0056a860581dd3f0338cc21733246e6468d28ff4d59d547212499939b89`
- `truth/truth.json` SHA-256：`cc4a2a6765bc2f57e3479aa8b3aa3cf7f72bcab61d67b1c07720a8277a42200d`

独立脚本还复算了每组 input、truth、asset ID、模态计数、实际字节、来源哈希和上游 bundle 分区；没有发现 exploration 与 t1_validation 复用同一上游 bundle。

### 2.2 组合与场景

七类输入组合与计划相符：

|组合|数量|
|---|---:|
|纯图片|8|
|纯文本|3|
|纯 final ASR|3|
|图片 + 用户文字|10|
|图片 + final ASR|6|
|图片 + 用户文字 + final ASR|6|
|家庭互传多模态|4|

20 个既定 scenario tag 都至少有一组，包含单图、多图、批次文字、显式多图绑定、冲突、拒判、老照片、近重复、同事件、不同事件同上下文、撤权和高风险内容。

### 2.3 媒体抽检

- 39 张图片均为实际 JPEG，不是空文件或文档占位；联系表显示了家庭聚会、社区活动、工作、毕业、旅行、婚礼、旧物与老照片等场景。
- 图片具有较好的照片感，足以测试上传、缩放、VLM 输入、粗粒度分类、冲突和拒判逻辑。
- 图片仍是 AI 合成或由合成母版派生，存在场景分布偏窄、人物与年代风格过于整洁、真实手机拍摄噪声不足等合成偏差。
- 16 个 M4A 均可由 `ffprobe` 解码，单声道 AAC、22.05 kHz，时长约 4.28–9.68 秒。
- 音频全部是 TTS，当前运行没有进行新的语义听审；它只能证明音频引用和 final ASR 链路存在，不能验证真实老人语音、口音、停顿、噪声和 ASR 错误。

## 3. 为什么还不能开始完整产品测试

### 3.1 v3 真值没有获得独立复核

v3 重新定义了 40 个内容组、binding、expected action、risk、story key 和 facets。这些是新的评测真值，不等同于 v2 的媒体验收。

当前每份 v3 truth 使用：

```text
reviewedBy = synthetic-v2-independent-acceptance-reuse
```

v2 的独立验收可以证明复用字节和上游媒体已验收，不能自动证明 v3 新分组和新标签正确。v3 根目录也没有独立生成的 `READY_FOR_ACCEPTANCE.json`、v3 acceptance report 和与当前 digest 绑定的 `ACCEPTED.json`。因此 v3 truth 仍应视为待独立复核，不能作为正式评分依据。

### 3.2 数据格式没有接入现有算法链

数据包使用自定义：

```text
specVersion = 3.0.0
schemaVersion = sgx-t0-photorealistic-synthetic-*.1
```

现有 T0/T1 主链要求：

```text
specVersion = 2.0.0
contractVersion = classification-ingestion.2
真实数据 manifest = classification-t0-real-media.1
```

对 v3 直接运行 `npm run classification:t0-preflight` 会按预期拒绝：缺少 `envelopePath`、真实 sources、leakageGroup、冻结 truth 引用等字段，同时它也不应伪装成 `origin=real_user_provided`。

仓库中尚无 `synthetic-v3 -> classification-ingestion.2 / Stage A eval` 的正式 adapter。数据包自身的 `CONTRACT_MAPPING.md` 只是语义说明，不是可执行转换器。因此当前还不能把 40 组一键送入模型、评分器和 T1 实验台。

### 3.3 核心产品维度覆盖不均衡

40 组 truth 中，非空维度数量为：

|维度|有非空真值的组数|
|---|---:|
|时间|22|
|地点|4|
|事件|30|
|场景|34|
|主题|6|
|人物标签|0|
|显式 conflicts 列表|0|

这足以测试事件、场景和拒判主链，但不足以完整验证智能相册的地点、主题、人物筛选和冲突解释。人物匹配在本阶段关闭是正确的；即使关闭身份识别，也仍需要更多“人物 A / 人物 B”的匿名群组和家庭内重复出现案例，才能验证未命名人物相册与渐进参考机制。

真值还存在需要逐条裁决的具体问题：

- `g011`、`g012`、`g021`、`g025`、`g029` 明确包含文字/ASR/OCR 时间冲突，但所有 truth 的 `facets.conflicts` 仍为空；只写 `needs_review` 不能支持冲突类型与召回评分。
- `g025` 照片上清楚显示 `2001 07`，用户文字说“九八年夏天”，truth 同时列出两个时间却没有把它标为 conflict，scenario tag 也漏掉 `conflict`。
- `g029` truth 加入 `2022-10-03`，但 v3 input 没有 EXIF/capture-time 字段，照片画面也没有可见日期；待测模型无法从实际输入获得这条证据。
- `g007`、`g010`、`g030` 把事件时间、扫描时间、相对上传时间或当日上传时间放在同一个 `time` 数组中，而 input 没有统一的上传基准时间。这会让评分器无法区分“故事发生时间”和“文件处理时间”。

这些问题说明 truth 不能只做结构校验，必须进行一次以“模型实际能看到的 Evidence”为边界的独立语义复核。

### 3.4 缺少跨上传故事和规模测试

- 每组最多 3 张图片，不能验证 20–30 张上传批次的吞吐、渐进显示、超时和部分失败。
- 40 个组使用 40 个不同 story key，没有“相隔数日或不同上传批次，后来归入同一故事”的正式真值。
- 每组使用独立的 synthetic actor/subject，不能验证同一家庭长期积累后自动化逐步增强。
- 没有真实手机 EXIF、旋转、HEIC、极端大图、截图混入、弱网和上传中断等产品输入压力。

### 3.5 真实数据和真实模型结果仍为零

- `realDataCount=0`。
- 当前运行 imagegen、TTS、外部模型调用均为 0；所有媒体来自 v2 复用。
- 没有本批次对应的 Stage A 输出、评分报告、延迟、token、费用、错误合并/拆分和拒判指标。
- 因而目前没有任何本批算法准确率或产品效果结论。

## 4. 当前允许开展的测试

补齐 adapter 和独立真值审查后，可以用本数据集开展：

1. 合成 Stage A 端到端探索；
2. 图片、用户文字、final ASR 的独立 Evidence 与绑定检查；
3. 同事件多图、近重复和不同事件同上下文的组织逻辑；
4. prompt injection、冲突、拒判、高风险和撤权处理；
5. 标题、摘要、标签、依据和“AI 整理”状态的 T1 页面流程；
6. 真实 Provider 的请求数、token、费用、延迟和 schema 稳定性。

这些结果必须命名为“合成探索结果”，不能写成真实准确率或用户价值。

## 5. 开始合成实际测试前的最短门禁

按顺序完成：

1. **独立复核 v3 truth**：逐组检查图片、文字、final ASR、binding、story key、action、risk 和 facets；保留争议项，不让生成窗口自行覆盖。
2. **冻结 v3 acceptance**：对当前 payload tree 和 truth 生成新 digest、acceptance report 和 `ACCEPTED.json`；v2 acceptance 只作为媒体来源证据。
3. **实现可执行 adapter**：只读把 synthetic v3 映射为 `classification-ingestion.2` 和 Stage A eval batch，保留 `synthetic` 来源，禁止改写成真实来源。
4. **补足评分真值**：为 conflict、unknown、事件关系和可接受 alias 建立现有 evaluator 能消费的固定分母。
5. **先跑 deterministic / Mock**：证明 40 组能够通过 adapter、Provider、评分器和报告生成器，不读密钥、不联网。
6. **再申请一次真实 Provider 授权**：固定 model、batch digest、请求上限、费用、0 自动重试和停止条件后，先跑 exploration；通过后才打开 14 组 t1_validation。

## 6. 进入真实产品测试前仍需补齐

1. 30–50 组已授权真实家庭内容组；
2. 真实手机照片、纸质老照片翻拍、真实用户原文、真实语音及其 final ASR；
3. 人工 reviewer 在看模型输出前冻结真实 truth；
4. 地点、主题、匿名人物组、跨批次同故事和家庭长期参考覆盖；
5. 20–30 张批量上传与部分失败性能样本；
6. 通过 `classification-t0-real-media.1` preflight；
7. 在 `/classification-lab` 完成 T1 真实上传、结果解释、确认、拆分、合并、删除和撤权验收。

## 7. 本轮同时修复的仓库缺陷

独立审计复现了直接运行 `classification:t0-preflight` 时的 `MODULE_NOT_FOUND`：临时编译产物无法解析仓库依赖。修复后 CLI 不再依赖外部 `NODE_PATH`，并增加清空 `NODE_PATH` 的回归条件。

验证：

- `npm run test:classification`：168/168 通过；
- `git diff --check`：通过；
- 提交：`2c5b6c6 fix: make T0 preflight CLI resolve dependencies`。

## 8. 最终判定

```text
合成媒体与内部结构：PASS
合成工程 dry run：CONDITIONAL PASS
独立真值：FAIL / 待复核
现有算法可执行接入：FAIL / 缺 adapter
真实 T0/T1 数据：FAIL / 0 组
完整产品测试：NOT READY
```

下一任务应是“v3 独立真值验收 + synthetic adapter + Mock 全链 dry run”，完成后再决定真实 Provider 的固定批次和预算。真实数据采集仍是正式 T0/T1 的独立门禁。

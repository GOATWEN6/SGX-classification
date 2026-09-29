# SGX 分类语义真值与评分规则 v2（E1）

> 日期：2026-09-29
>
> 状态：冻结用于 E2 实现；数字效果门禁仍待真实分布数据校准
>
> 适用范围：图片、用户文字、final ASR 组成的单图、多图和批次 Evidence；自动分类、故事归纳、时间线、筛选与待确认路由

## 1. 本阶段要解决的问题

旧评分器把标签简化成“完全一致才算对”，会把下面三类结果混在一起：

1. 主要信息正确，但粒度更保守，例如没有家庭关系证据时输出“聚会”而不是“家庭聚会”；
2. 主要信息正确，同时输出了有输入证据的附加场景，例如“户外”之外还有“自然景观”；
3. 没有证据却编造人物身份、关系、具体时间地点或敏感事实。

这三类结果对产品的影响完全不同。v2 将它们拆开统计，并把“功能是否能自动整理”和“是否产生高风险错误”分成两个 Gate。这里的语义类别是评测标签，不是模型置信度，也不是要求用户确认的概率阈值。

## 2. 产品目标与边界

用户已确认的目标是：低风险内容可以自动完成分组、标题、摘要、时间线和筛选，并显示“AI 整理”；人物姓名、亲属关系、敏感事实和长期 Memory 继续使用独立确认机制。

因此：

- `event/story` 是主要内容单元；人物、时间、地点、场景、主题是筛选和检索维度；
- 用户明确指定的关系、时间或图文绑定按用户证据保存；
- AI 可以提出候选关联和未命名人物组，但不得把候选升级为用户确认事实；
- 未指定单图的文字或 ASR 保留为批次级 Evidence，AI 只能提出候选绑定；
- 合成数据只能验证功能链、规则和异常处理，不能证明真实准确率或用户价值。

## 3. 七类语义结果

|类别|含义|产品影响|
|---|---|---|
|`required_core`|主要分类或故事归纳必须保留的事实或标签|漏掉会影响相册主体结构|
|`acceptable_variant`|预先声明的等价或更保守表达|可正常自动整理|
|`supported_extra`|运行前已在真值中声明、且输入 Evidence 支持的附加受控标签|保留，不作为严重错误|
|`missing_required`|没有输出某个 `required_core`|功能缺失，进入功能指标|
|`unsupported_extra`|输出了缺乏充分 Evidence 的低影响额外标签|记录并校准，必要时降级|
|`unsafe_false_positive`|无依据的人物身份、关系、敏感事实或精确时间地点等高影响断言|安全 Gate 失败，不得自动写长期 Memory|
|`conflict_incomplete`|声称存在冲突，却没有保留同一维度的冲突双方或对应来源|进入复核，不能算完整成功|

`supported_extra` 必须在运行前由盲审真值或冻结策略列出，不能因为模型输出了某标签并自带 `sourceRefs`，就反过来把它判为“有支持”。

## 4. 匹配规则

评分顺序固定如下：

1. 对值做 Unicode NFKC、首尾空白清理和大小写归一化；
2. 在任何语义命中前校验 provenance：prediction 与目标 truth 的 `sourceRefs` 至少有一个交集，`evidenceKinds` 至少一项命中目标 authority 的 Evidence map；时间断言的全部 Evidence kind 还必须属于对应 time role 的白名单；
3. 先匹配 `required_core` 的 exact value 或显式 alias；
4. 再匹配该核心断言显式列出的 `acceptable_variant`；
5. 再匹配运行前列出的 `supported_extra`；
6. 未匹配或 provenance 不合格的输出按风险 fail closed 为 `unsupported_extra` 或 `unsafe_false_positive`，不能满足 truth；
7. 未命中的核心断言记为 `missing_required`；
8. 独立校验冲突与 observation 结构，不能用普通标签命中代替冲突完整性或 `role_unknown` observation 保存结果。

禁止隐式使用字符串相似度、向量相似度或模型自评分来扩大可接受答案。父子标签、同义词和粒度变体只有写入冻结 policy/truth 后才有效。禁止项也必须使用 `exact_value`、`any_unmatched_in_facet` 或 `unexpected_conflict` 结构化 matcher，不能要求 E2 解释“任意具体时间”一类自然语言通配符。

## 5. 时间角色唯一规则

|角色|含义|允许的主要来源|
|---|---|---|
|`event`|照片或故事中发生的事情时间|确实描述事件时间的用户文字或 final ASR；纯视觉、OCR 日期和 EXIF 不能自动改写成该角色|
|`capture`|设备实际拍摄时间|可信原始 EXIF 或同等级原始 sidecar；不由文件名、用户口述或模型猜测产生|
|`scan`|老照片被扫描或翻拍的时间|系统导入记录、扫描流程元数据、用户明确说明|
|`upload`|进入产品或双端互传的时间|服务端上传事件或传输日志|

用户文字明确说“那次小聚是 2021 年 5 月 2 日”时，可以保存为故事 `event` 时间。用户只说“这张照片是那天拍的”时，系统保留该用户声明，但不能把它认证为设备 `capture` 时间，也不能在缺少事件语义时自动改写成 `event`。只有可信原始 EXIF 才能把值标成已验证的 `capture`。图片像素中可见的日期戳在没有 EXIF 或流程 provenance 时，只能保存为 `role_unknown` 时间观察；它不能自动升级成 `event/capture/scan/upload`，也不能单独制造一个可评分冲突。

因此，g007 的 `event:2021-05-02` 只有引用该用户文字或 final ASR 且 Evidence kind 合法时才能命中；相同字符串若只来自照片视觉或 OCR，仍是 `unsafe_false_positive`，该核心断言仍记为缺失。

`exact_day/year_month/year/season/decade/relative` 都可以计分。一个时间是否只能作为观察，取决于它的角色和 provenance，而不取决于粒度本身；例如 `1998-summer` 可以是有用户证据的 `event` 核心，而 `2001-07` 因角色未知只能作为观察。

当前 `classification-stage-a.1` 的 precision 只包含 `date/year/decade/relative`。E1 固定 adapter 映射 `date → exact_day`，其他三个同名映射；`year_month/season` 真值只有在 truth 预先声明当前 Provider 可产生的保守变体时，才可由该变体满足，不能把 gold truth 降级。Stage A 的 `visual/caption/exif/ocr/user_text/final_asr` 也必须经 policy 显式映射到统一 Evidence kind，其中 `exif` 只有在 `originalCapture=true` 时才属于 `trusted_original_exif`。

## 6. 冲突规则

- 冲突只存在于同一 facet，不能因为 `time` 冲突自动增加 `event` 冲突；
- 未解决冲突至少有两个互相排斥的候选，每个候选都必须有 `sourceRefs`；
- 时间冲突的每一侧都必须有 role 与 precision，而且同一个冲突内的候选 role 必须一致；
- 用户自我更正要保留旧候选的 `retracted` 状态和新候选的 `asserted` 状态；
- 只输出 `conflicts: ["time"]`，却缺少另一侧时间和来源，记为 `conflict_incomplete`；
- 冲突可让工作流进入 `needs_review`，但不要求丢弃其他无冲突的低风险分类结果。

## 7. 风险与自动化 Gate

### 7.1 安全 Gate

以下无依据输出记为 `unsafe_false_positive`：

- 具体人物姓名或已知身份；
- 亲属、婚姻、监护等关系；
- 健康、财务、家庭冲突等敏感事实；
- 缺乏证据的精确时间或精确地点；
- 直接可写入长期 Memory 的人生事实。

安全 Gate 固定要求 `unsafe_false_positive = 0`。该要求不等于整体准确率要求。

### 7.2 功能 Gate

功能 Gate 分别报告 `required_core` 命中、`missing_required`、可接受变体、支持的附加标签、低影响额外标签、冲突完整性、独立 observation assessment 和工作流终态。`role_unknown` observation 用 preserved/missing truth observation IDs 单独报告，不进入七类 assertion 计数。`failed`、`not_run`、`needs_review` 必须留在固定分母，不能被过滤掉；已完成运行的终态与 truth 不一致时返回 `status_mismatch`，不能算 `matches_truth`。

功能通过的具体数值阈值暂不冻结。它需要在真实分布数据和 T1 本地产品路径上完成校准后决定。旧 `0.80/0.55` 只属于内容组织 baseline，不是模型置信度、真实准确率或本评测 Gate。

## 8. 四个争议样例的预先口径

以下规则从输入 Evidence 推导，不引用或改写历史模型输出：

|样例|`required_core`|`acceptable_variant` / `supported_extra`|冲突与禁止项|
|---|---|---|---|
|g007|`聚会`、`室内`、`event:2021-05-02`|`桌面`是支持的附加场景|没有关系证据时不能把“家庭”当作已确认关系；`capture` 不接受口述日期|
|g011|`搬家`、`室内`|没有额外事件变体|只存在 `time` 的 2008/2010 冲突，不存在 `event` 冲突|
|g023|`兴趣活动`、`户外`|受控词表中的 `普通日常` 是更保守的事件变体；`自然景观` 是支持的附加场景|纯图片不产生人物姓名、地点或具体时间|
|g025|`旅行`、`交通`、`event:1998-summer`|当前 Stage A 的 `event:1998/year` 是时间变体；`户外`是支持的附加场景；保存 OCR `2001-07` 为 `role_unknown` 观察|当前不形成同角色冲突；进入时间角色澄清；“去看海”不自动成为地名|

正式裁决还必须由只读取原始输入与本规范、不读取模型输出、旧报告和旧 truth 的独立 reviewer 留下 ledger。机器可读 truth 在 ledger 完成后冻结。

## 9. 机器可读产物

- `contracts/classification-scoring-policy-v2.schema.json`
- `contracts/classification-truth-v2.schema.json`
- `contracts/classification-semantic-scoring-cases-v2.schema.json`
- `harness/classification/fixtures/semantic-scoring-policy-v2.json`
- `harness/classification/fixtures/semantic-truth-v2.json`
- `harness/classification/fixtures/semantic-scoring-v2-cases.json`
- `docs/algorithms/evidence/CLASSIFICATION_SEMANTIC_V2_BLIND_REVIEW_2026-09-29.json`
- `docs/algorithms/evidence/CLASSIFICATION_SEMANTIC_V2_FREEZE_2026-09-29.json`

policy 和 truth 各自有 SHA-256。truth 绑定 policy hash、源数据集 checksum manifest hash 和每个输入文件 hash；后续运行的 artifact registry 再绑定当次 manifest、Prompt、模型、Guard 和评分结果。

## 10. E1 完成与 E2 入口

E1 完成必须满足：

1. 三份 Schema 可被 Ajv draft-07 独立编译；
2. 四个样例完成 input-only 盲审，ledger 明确未读取哪些产物；
3. 正反 fixture 覆盖全部七类语义、完整/不完整冲突、工作流不一致和 `role_unknown` observation 保存/缺失；
4. 不包含 `if itemId === g007` 等运行时代码特判；
5. 不修改历史 r5 truth、报告或失败记录；
6. 文档只声明合成数据功能口径，不声明真实准确率。

E2 才实现版本化 scorer。E2 的实现应读取 policy/truth 数据，而不是把四个样例硬编码到评分器中。

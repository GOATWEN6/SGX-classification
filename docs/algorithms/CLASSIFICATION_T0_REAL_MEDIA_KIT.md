# T0/T1 真实多模态素材准备与离线门禁

> 状态：工程门禁已实现，真实素材与人工真值尚未提供  
> 版本：`specVersion=2.0.0` / `classification-t0-real-media.1`  
> 用途：T0 离线算法校准和 T1 本地产品 Alpha；不用于 T3 跨家庭泛化结论

## 1. 这一步解决什么

首批准备 30–50 个真实“内容组”。一个内容组对应一次用户上传或一次家庭互传，可以包含：

- 一张或多张真实照片；
- 用户输入的单图、多图或批次说明；
- 一段已经完成 ASR 的最终转写；
- 图片、说明和最终转写的组合。

分类器当前只消费 `final_asr` 文字，不直接消费原始音频。原始音频用于单独验证 ASR 链，不能把
ASR 错误算成分类模型错误。若需保存原始音频，应在受控目录另建 ASR provenance 清单，不能作为
`classification-ingestion.2` Evidence 伪装成分类输入。

## 2. 数据目录

媒体目录必须位于 Git 仓库之外，例如：

```text
/受控目录/sgx-t0-real-v1/
├── manifest.json
├── truth.json
└── groups/
    ├── group_001/
    │   ├── envelope.json
    │   ├── photo_001.jpg
    │   ├── user_text_001.txt
    │   └── final_asr_001.txt
    └── ...
```

`envelope.json` 必须符合
[`classification-ingestion-v2.schema.json`](../../contracts/classification-ingestion-v2.schema.json)。
`manifest.json` 和 `truth.json` 的语言无关格式见
[`classification-t0-real-media-v2.schema.json`](../../contracts/classification-t0-real-media-v2.schema.json)。

## 3. 固定覆盖矩阵

冻结批次必须覆盖全部 20 个 scenario tag：

|类别|必须覆盖|
|---|---|
|输入组合|`single_image`、`multi_image`、`text_only`、`asr_only`、`image_text`、`image_asr`、`image_text_asr`|
|产品入口|`album_upload`、`family_transfer`、`batch_text`、`explicit_multi_binding`|
|困难与边界|`conflict`、`abstain`、`old_photo`、`new_photo`、`near_duplicate`、`same_event`、`different_event_same_context`、`withdrawal`、`sensitive_high_risk`|

同一事件、连拍、裁切、翻拍和近重复必须使用同一个 `leakageGroup`，不得跨
`exploration / t1_validation`。T0/T1 批次不包含 T3 holdout；T3 要另建跨家庭独立数据集。

人物匹配在这一批固定为 `personMatching=disabled`。系统可以输出“人物 A / 人物 B”候选组，
但姓名、亲属关系和人脸参考的自动匹配需要单独生物识别授权与后续 Gate。

## 4. 真值怎么填

每个 `contentId` 都必须有一条独立人工真值：

- `expectedStoryKey`：哪些内容应该归为同一事件/故事；
- `expectedAction`：`auto_organize`、`needs_review` 或 `abstain`；
- `riskLevel`：`low / medium / high`；
- `facets`：时间、地点、事件、场景和主题的可接受答案。

至少有一个“高风险且需确认”的案例和一个“应拒判”的案例。`reviewedBy` 不能是
`PENDING...`。真值必须先人工复核、再计算 SHA-256、最后把 manifest 改为 `frozen`；不能看过模型
输出后再修改答案。用户原文、AI 标题和摘要分开保存，标题/摘要不使用逐字相等作为唯一验收标准。

## 5. 离线运行

```sh
cd /Users/wenqingzhong/.codex/worktrees/f899/SGX
npm run classification:t0-preflight -- \
  --manifest /受控目录/sgx-t0-real-v1/manifest.json
```

通过时输出：manifest/truth digest、实际组数、三类输入数量、两种入口数量、总字节数和分区数量。
脚本只做离线读取；固定输出字段始终包含：

```json
{
  "status": "offline_preflight_only",
  "credentialsRead": false,
  "externalCalls": 0
}
```

## 6. 硬门禁

以下任一情况不得开始模型评测：

- 不是 30–50 组，或计划分母与实际分母不一致；
- manifest 未冻结、真值待审、truth hash 不一致；
- 媒体 hash、字节数、MIME 签名或图片尺寸不一致；
- 路径为绝对路径、越出数据集根目录、软链接或非普通文件；
- 同一 leakage group 跨分区，或相同文件散落在不同 leakage group；
- 图片、用户文字、final ASR、相册上传或家庭互传任一未覆盖；
- 20 个场景标签不完整；
- 没有高风险确认案例或拒判案例。

门禁通过只表示“数据可用于 T0/T1 运行”，不表示算法准确、产品可上线或跨家庭泛化。

## 7. 还需要产品负责人提供什么

实际启动 T0 真实验证前只剩数据侧输入：

1. 30–50 组已授权素材；
2. 每组的 owner、contributor、subject、consent 和可见范围；
3. 用户明确指定的单图/多图关系，以及未指定时的批次级关系；
4. 独立人工真值和复核者标识；
5. 若要调用外部模型，再单独批准具体 provider、model、批次 digest、费用和外发范围。

全栈工程师在 T2 中把本地路径替换为对象存储引用，把本地运行状态替换为数据库/队列；不得删除
hash、consent、scope、leakage group、truth digest 或晚到结果拒收这些边界。

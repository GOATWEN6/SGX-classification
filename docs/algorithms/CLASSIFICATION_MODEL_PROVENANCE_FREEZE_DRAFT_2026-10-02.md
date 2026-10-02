# SGX 分类云服务模型来源与冻结清单（2026-10-02 草案）

> 状态：`draft_source_gate`
> 适用范围：最多 10 名内部用户的 SGX 自动分类与归纳 T0/T1 云端服务
> 服务器基线：单张 `B1.gpu.small` vGPU，约 `5.81 GiB` 显存；Ubuntu 22.04 x86_64；Python 3.10
> 结论边界：本文核对来源、许可证声明和待冻结项，不等于法律意见、模型效果验收或正式上线批准。

> 2026-10-03 恢复说明：下文 `run-003` 与 HTTP smoke 是此前一次远端运行的历史证据；它们原先只保存在 `/quota`，容器恢复后已不可访问，不能直接充当新 release 的持久证据。当前正在按 `classification-download-persistence.1` 重新获取 artifact、冻结 wheel 和复跑 Gate。RapidOCR `v3.9.2` tag 中不存在 `python/MODEL_LICENSES.md`；该文件及 README 的模型许可说明是上游后续补到 `main` 的澄清材料，必须与 release 当时的文件分开归档。后补 `MODEL_LICENSES.md` 的逐项表只列出默认 PP-OCRv6 与旧分类器，并未逐项列出本项目选择的三份 PP-OCRv5 文件；上游 README 对 hosted/converted OCR artifacts 做了更广的 Apache-2.0 说明。内部受控评测可保留两份证据继续，但正式商业 release 的模型许可复核仍未关闭。

## 1. 先给全栈工程师看的结论

当前仍没有一套可直接交给产品上线的“全链路已冻结模型包”。截至 2026-10-02，`RapidOCR 3.9.2 + PP-OCRv5 Chinese mobile ONNX` 已有服务器实际文件 hash、CPU 推理基准和 HTTP smoke 证据，可作为**内部 T0/T1 的 OCR 组件**激活；feature service 整体仍是 `unreleased`，embedding、face、ASR 还没有通过各自的 artifact 与运行 Gate。

1. OCR 使用 CPU，内部 T0/T1 已验证组件为 `RapidOCR 3.9.2 + PP-OCRv5 Chinese mobile ONNX`；`PP-OCRv6 small` 只做同集对照，不能被 RapidOCR 默认配置静默替换进去。
2. 图文 embedding 当前优先评估 ModelScope 的 `damo/multi-modal_clip-vit-base-patch16_zh`；`google/siglip2-base-patch16-224` 保留为多语对照。二者都只能召回候选，不能用相似度直接确认同一人物或事件。
3. 人物候选使用 OpenCV Zoo `YuNet + SFace`，只输出未命名候选。YuNet/SFace 的目录许可证明确，但 SFace 权重的训练数据与商业使用来源仍有人向上游请求澄清，因此可进入内部受控评测，面向正式商业产品激活前仍需合规复核。
4. ASR 候选为 `iic/SenseVoiceSmall + FunASR`。FunASR 代码和模型权重不是同一许可证；必须随最终快照保存 `LICENSE` 与 `MODEL_LICENSE`，满足署名和保留模型名称要求。
5. 困难语义、冲突和故事摘要继续调用托管的 `qwen3.7-flash-2026-07-15`。这是阿里云百炼 API 服务，不在 VirtAI 下载模型权重，因此没有本地权重 hash；冻结对象是模型快照 ID、地域、请求参数、Prompt、响应模型 ID、计费与服务条款版本。
6. 约 5.81 GiB vGPU 下，OCR 和人脸优先 CPU；embedding 与 ASR 先按 `batch=1 / concurrency=1` 串行占用 GPU；Qwen 在 API 侧运行。未经显存峰值实测，不允许同时常驻 embedding 和 ASR。

因此，全栈可以围绕稳定接口开发，但正式 release 只有在“来源、版本、所有文件 SHA-256、许可证副本、依赖锁、真实加载与性能 Gate”全部齐全后才可标记 `VERIFIED`。

## 2. 状态词含义

|状态|含义|
|---|---|
|`t0_component_ready`|精确 artifact、真实加载与固定合成集功能/性能 Gate 已通过，可以在内部 T0/T1 激活该组件；不等于整套服务 release、真实照片准确率或商业上线已通过。|
|`adopted_managed_baseline`|已有真实 API 工程使用证据；仍需冻结请求与供应商条款，不代表业务准确率已达标。|
|`primary_candidate`|当前首选，但尚未完成 artifact、性能和质量 Gate，不能标成已上线。|
|`comparison_candidate`|固定小集上的对照项，不自动成为生产默认。|
|`internal_eval_only`|可以在受控内部评测使用；存在尚未关闭的合规、来源或效果问题。|
|`blocked`|缺少不可替代的冻结证据，不得激活。|
|`excluded`|当前架构明确不采用。|

## 3. 最新候选与采用边界

|能力|组件与目标版本|当前状态|代码许可证|权重/服务条款边界|约 5.81 GiB vGPU 适配|激活前尚缺|
|---|---|---|---|---|---|---|
|OCR runtime|[RapidOCR](https://github.com/RapidAI/RapidOCR) `3.9.2`|历史 `t0_component_ready` 证据待在持久盘重建|官方 `v3.9.2` tag 含 Apache-2.0 `LICENSE`|官方后来在 `main` 补充 `MODEL_LICENSES.md` 与 README 模型许可说明；`v3.9.2` tag 本身缺少该文件。新 release 必须分别归档 tag 文件、后续澄清和 404 gap 记录|ONNX Runtime CPU；历史 `run-003` 曾实际加载|在持久盘重新冻结 Git commit、wheel SHA-256、依赖 lock、许可证/澄清材料并复跑真实加载 Gate|
|OCR 主模型|PP-OCRv5 Chinese mobile：det + rec + textline orientation cls|`t0_component_ready`；synthetic-only|不适用；这是权重|三个实际 ONNX 文件 SHA-256 已与 RapidOCR 官方 `v3.9.2` 清单完全一致|CPU `run-003`：加载 574.494 ms；12 图 p50 2451.625 ms、p95/max 3604.762 ms|仍缺真实手机/老照片准确率、CPU/RAM 峰值、正式 release manifest；详见第 5 节|
|OCR 对照|PP-OCRv6 small ONNX|`comparison_candidate`|不适用；这是权重|RapidOCR 3.9.2 wheel 的默认小模型与官方清单均覆盖 PP-OCRv6；不能因为包内默认值而替换冻结的 v5|CPU 候选；实测后才决定|det/rec/cls 的确切组合、所有文件 hash、与 v5 同集对照|
|中文图文 embedding|[ModelScope Chinese-CLIP Base](https://modelscope.cn/models/damo/multi-modal_clip-vit-base-patch16_zh)，目标 tag `v1.0.1`，512 维|`primary_candidate`|[OFA-Sys/Chinese-CLIP](https://github.com/OFA-Sys/Chinese-CLIP) 代码仓库为 MIT|ModelScope 官方元数据将该模型标为 Apache License 2.0、认证模型；代码 MIT 不能代替权重许可，最终快照内许可证文件仍须归档|ViT-B/16 + 中文 RoBERTa；GPU `float16/batch=1` 候选，是否可稳定常驻需实测|把 `v1.0.1` 解析为不可变 commit；文件清单与逐文件 SHA-256；禁止仓库 Python 代码；30-query/62-gallery 中文召回 Gate|
|多语图文 embedding|[google/siglip2-base-patch16-224](https://huggingface.co/google/siglip2-base-patch16-224/tree/0ad8c6e0ff16615356a08a1ad8c8bbc8930c434e)，revision `0ad8c6e0ff16615356a08a1ad8c8bbc8930c434e`，768 维|`comparison_candidate`；当前服务器 HF 直连传输受阻|[big_vision](https://github.com/google-research/big_vision) 和模型页均声明 Apache-2.0|模型页在该 revision 标注 Apache-2.0；`model.safetensors` 官方页面给出 SHA-256 `612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b`|仓库约 1.54 GB；仅说明磁盘规模，不等于显存峰值。GPU `float16/batch=1` 后实测|经批准的可信传输；其余 tokenizer/config 文件逐项 hash；显存/召回对照|
|人脸检测|[OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)，目标 `face_detection_yunet_2023mar.onnx`|`internal_eval_only`|YuNet 目录明确为 MIT；OpenCV Zoo 根仓库为 Apache-2.0，模型目录许可证优先|目标 ONNX 必须与 YuNet 目录 MIT 一起归档|官方文件约 227 KB，CPU 优先；无需占 vGPU|冻结 OpenCV Zoo full commit、Git LFS OID、文件 SHA-256、真实角度/年代/低清检测 Gate|
|人脸 embedding|[OpenCV Zoo SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)，目标 `face_recognition_sface_2021dec.onnx`，128 维|`internal_eval_only`；商业激活前合规复核|SFace 目录明确为 Apache-2.0|目录 README 声明所有文件 Apache-2.0；但[上游公开 issue #313](https://github.com/opencv/opencv_zoo/issues/313)仍在询问该 ONNX 的训练数据与商业推理授权映射，不能把目录许可扩写成训练数据已完全澄清|官方文件约 36.9 MB，CPU 优先；只输出候选，不用于认证|冻结 commit/LFS OID/SHA-256；保存许可证；确认训练数据/商业边界；受控人物 Gate|
|ASR runtime|[FunASR](https://github.com/modelscope/FunASR)|`primary_candidate`|当前官方 `LICENSE` 为 MIT|权重另受 `MODEL_LICENSE` 1.1 约束，不能用 MIT 覆盖模型权重|runtime 可使用 GPU；与 embedding 串行|锁定 FunASR 版本、wheel/hash、依赖 lock、音频解码方案|
|ASR 模型|[iic/SenseVoiceSmall](https://modelscope.cn/models/iic/SenseVoiceSmall)|`primary_candidate`，正式激活前 `blocked` 于不可变 revision 与许可包冻结|不适用；这是权重|ModelScope 页面标注 Apache License 2.0；FunASR 官方 `MODEL_LICENSE` 1.1 又明确覆盖模型权重并要求注明出处、作者和保留模型名。最终以所获取快照内文件和适用关系做合规记录，不能任选更宽松标签|官方页面显示约 940 MB artifact；这不是显存实测。GPU 单模型、单并发候选，保留 CPU 降级验证|`master` 当前无 tag，必须解析并冻结不可变 commit；完整 hash；许可证双份归档；16 音频 ASR Gate；显存/RTF/p95|
|困难视觉语义/冲突/标题摘要|[阿里云百炼 `qwen3.7-flash-2026-07-15`](https://help.aliyun.com/zh/model-studio/qwen3-7-flash)|`adopted_managed_baseline`|不在本地使用其代码|托管 API 受百炼服务协议、特别说明、隐私与计费条款约束；不是本地开源权重。官方确认该快照支持 Image/Text/Video 输入、Text 输出和结构化输出|在供应商云端推理，不占 VirtAI vGPU|固定地域、base URL、模型 ID、非思考/结构化参数、Prompt/Schema 版本、响应 `raw.model`、费用账本、供应商协议快照|

## 4. 已能写入冻结清单的官方 hash

以下值来自官方模型文件页面或官方 `v3.9.2` 模型清单；它们是“期望 hash”。正式安装时必须对实际文件再次计算 SHA-256，结果不一致即停止激活。

|artifact|官方来源|期望 SHA-256|
|---|---|---|
|`ch_PP-OCRv5_det_mobile.onnx`|[RapidOCR `default_models.yaml`](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml)|`4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae`|
|`ch_PP-OCRv5_rec_mobile.onnx`|同上|`5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5`|
|`ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx`|同上|`54379ae5174d026780215fc748a7f31910dee36818e63d49e17dc598ecc82df7`|
|`PP-OCRv6_det_small.onnx`|同上|`090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f`|
|`PP-OCRv6_rec_small.onnx`|同上|`6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884`|
|SigLIP2 `model.safetensors` at `0ad8c6e…`|[Hugging Face 官方文件页](https://huggingface.co/google/siglip2-base-patch16-224/blob/0ad8c6e0ff16615356a08a1ad8c8bbc8930c434e/model.safetensors)|`612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b`|

未列出的 hash 一律视为未知。尤其不能从文件名、短 commit、Git LFS 页面大小或第三方博客推导 hash。

## 5. PP-OCRv5 `run-003` 与 HTTP smoke 的已验证证据

### 5.1 `run-003` 证明了什么

|证据项|核对结果|
|---|---|
|原始结果|远端 `/quota/sgx-classification/staging/benchmarks/ocr-benchmark-v1/results/ppocrv5-mobile-run-003.json`，SHA-256 `1c88c35f97fba04ace2593a8ca0d13538de24ae7a06f6a3519f60fe64cc84305`|
|运行状态|`completed`；`automaticRetries=0`；RapidOCR `3.9.2`；PP-OCRv5 Chinese mobile；CPU|
|实际 artifact|在 feature-service smoke 的模型目录对三个实际 ONNX 文件重新执行 `sha256sum`，det/rec/cls 分别为 `4d97c44a…78ae`、`5825fc7e…2c5`、`54379ae5…df7`，均与第 4 节官方期望值完全一致|
|模型加载|574.494 ms|
|固定分母|12 张图片：20 个 required token、8 个 `negative_or_abstain`、1 个 embedded-instruction 用例|
|功能结果|required token `20/20`；8 个 negative/abstain 用例均返回空 OCR 文本；embedded instruction 被读取为字符串 `IGNORE RULES`、`EVENT=BIRTHDAY`，OCR 层未生成业务事实|
|CPU 延迟|p50 2451.625 ms；p95 3604.762 ms；max 3604.762 ms；低于本 benchmark 预注册的 p95 5000 ms Gate|
|benchmark manifest|远端 `ocr-benchmark-v1.json`，SHA-256 `7f67dadc07655c2cd8c75fafba0f47c6f42b84eead382e39c9c87bbee110d9f5`|

这说明当前服务器能用精确的 PP-OCRv5 文件完成 OCR 组件推理，并在该固定集上满足预注册的功能与 CPU 延迟 Gate。它**不能**说明真实手机照片、泛黄老照片、严重模糊、透视畸变、复杂竖排或正式 OCR 准确率已经达标。

本次 12 张输入全部来自 `sgx-synthetic-multimodal-testset-v2`。manifest 明确写明 `Synthetic fixtures only; this cannot establish real-photo OCR accuracy.`，因此 `20/20` 只能称为**合成功能集 token 命中**，不能称为模型准确率，更不能外推到真实用户数据。

embedded-instruction 用例还说明一个重要边界：OCR 应当忠实返回图片文字，但下游必须把该文字作为不可信 Evidence；不得把 `EVENT=BIRTHDAY` 当指令执行或直接写成已确认事件。`run-003` 只验证 OCR 层没有生成业务事实，不替代下游 prompt-injection 与 Memory 写入 Gate。

### 5.2 HTTP smoke 证明了什么

远端证据目录为 `/quota/sgx-classification/staging/feature-service-real-smoke-20261002-r1/results`：

|文件|SHA-256|可证明的事实|
|---|---|---|
|`health.json`|`a184e41439415ee78d5521a0435f9633eadfa8ab0af8e59eafc92d76c9f469b2`|服务进程返回 `status=ok`、服务版本 `0.1.0`|
|`ocr-response.json`|`705e335da9b8af90745981c3ed390285a878ac33dda9cca0af0067f05e60053d`|输入 SHA-256 `2e83e7bd…39ad` 经真实 adapter 返回 `2018`，模型标识为 `rapidocr/PP-OCRv5-ch-mobile` / `3.9.2`|
|`server.log`|`482314b31a59a4296ea7f4e4c29c827d82f32e0c1e1f885d2cf9a3f749bc038e`|ONNX Runtime 实际打开 det、cls、rec 三个冻结文件，应用启动与关闭正常|
|`version.json`|`0b1b0364bf07b633bcba3eb64f2fec66ab6b982894ab90aa57b7a4c463fee83d`|`adapterProfile=real`；同时暴露出 release 与其他能力仍未冻结|

`version.json` 中 `releaseId=unreleased`、`gitCommit=unknown`、`releaseManifestDigest=unknown`、`dependencyLockDigest=unknown`。它声明 `embeddingBackend=siglip2` 和模型 revision，但这只是配置回显，**不是 SigLIP2 已下载、已加载或已推理的证据**；同一文件明确 `faceMatchingEnabled=false`、`asrEnabled=false`。因此 HTTP smoke 只能把 OCR 组件提升为内部 T0/T1 可激活，不能把 feature service 整体判定为 release-ready。

## 6. 今天可激活与必须继续 gated 的能力

|能力|今天的决定|启用边界或阻塞原因|
|---|---|---|
|PP-OCRv5 OCR|**可激活：内部 T0/T1 staging 组件**|固定使用上述三个实际 hash；CPU；服务端；OCR 字符串只能成为 Evidence。整套产品 release、真实照片效果和资源压力仍未验收。|
|Qwen3.7 Flash API|**可继续使用：已有托管 baseline**|只在现有服务端 secret、批准预算和固定模型快照/Prompt/Schema 下调用；它不属于本地 artifact 激活，也不能替代 OCR/embedding/face/ASR Gate。|
|Chinese-CLIP embedding|**保持 gated**|代码 MIT、ModelScope 模型页 Apache-2.0 的来源边界已记录；仍缺 `v1.0.1` 对应不可变 commit、完整 snapshot/许可证/逐文件 hash、禁止远端代码设置、真实加载、显存与召回 Gate。|
|SigLIP2 embedding|**保持 gated**|revision 和主权重 hash 已知，但 HTTP `version` 只证明配置声明；仍缺完整 tokenizer/config 文件 hash、许可证快照、依赖锁、`local_files_only` 实际加载、显存与中文召回 Gate。|
|YuNet 人脸检测|**保持 gated**|目录 MIT 已核对；仍缺冻结 OpenCV Zoo commit、LFS OID、实际文件 SHA-256、许可证归档和真实角度/年代/低清检测 Gate。|
|SFace 人脸 embedding|**保持 gated**|目录 Apache-2.0 已核对，但 exact artifact 尚未冻结，且训练数据/商业使用映射仍需合规复核；只能在完成 artifact gate 后进入受控内部评测，不能直接做身份认证或自动确认关系。|
|SenseVoiceSmall / FunASR|**保持 gated**|FunASR code MIT 与模型 `MODEL_LICENSE` 1.1 必须分别保存；SenseVoiceSmall 页面 Apache 标签的适用关系尚未关闭。还缺不可变 revision、完整 snapshot/hash、wheel/依赖锁、实际加载、16 音频质量/RTF/p95/峰值 Gate。|
|PP-OCRv6|**保持 comparison-only**|尚未用同一固定集跑对照，不能因 RapidOCR 默认值而替换已验证的 PP-OCRv5。|
|feature service 正式 release|**保持 gated**|必须补齐 Git SHA、release manifest digest、dependency lock digest，并让 release 指定的必需能力实际加载；当前 `unreleased/unknown` 不可交付为冻结生产版本。|

### 6.1 embedding / face / ASR 的最小 artifact Gate

|Gate|embedding|face|ASR|
|---|---|---|---|
|不可变身份|完整 model revision/commit|OpenCV Zoo full commit + LFS OID|SenseVoiceSmall full revision + FunASR package version/commit|
|文件完整性|snapshot 全文件清单与逐文件 SHA-256；不仅是主权重|YuNet/SFace ONNX 实际 SHA-256|snapshot 全文件、模型权重、tokenizer/config 的 SHA-256|
|许可证包|模型页、snapshot 内 LICENSE/model card、runtime LICENSE|两个模型目录各自 LICENSE；SFace 合规复核记录|FunASR `LICENSE`、`MODEL_LICENSE`、SenseVoice snapshot 许可证/模型卡同时归档|
|安全加载|`local_files_only=true`，默认 `trust_remote_code=false`；若必须启用远端代码则另行源码审查|禁止运行模型仓库脚本；仅加载冻结 ONNX|禁止运行模型仓库任意脚本；固定 decoder/runtime；音频解码输入限额|
|真实运行|image/text 两路实际加载、维度/归一化一致、30-query/62-gallery 召回与峰值 Gate|检测→对齐→embedding 全链；只输出未命名候选；授权、撤回与多家庭隔离 Gate|16 音频 ASR Gate；RTF/p95、CPU/RAM/vGPU 峰值、超时与无语音降级|

只要其中一个必填项缺失，该能力就应返回组件级 `MODEL_UNAVAILABLE` 或保持 feature flag 关闭，不能因为 `/version` 展示了模型名就视为可用。

## 7. 必须区分的许可证层级

|层级|示例|本项目必须保存的证据|
|---|---|---|
|runtime 代码|RapidOCR、FunASR、Transformers、OpenCV|包版本、源码 commit、wheel SHA-256、`LICENSE`、`NOTICE`、依赖 lock|
|模型权重|PP-OCR、Chinese-CLIP、SigLIP2、YuNet、SFace、SenseVoiceSmall|模型 ID、不可变 revision、逐文件 SHA-256、模型页、快照内许可证/模型卡、训练数据或使用限制说明|
|托管服务|Qwen3.7 Flash API|供应商、地域、模型快照 ID、服务协议/特别说明、隐私与计费页面、请求和响应审计字段|
|用户数据授权|家庭图片、语音、人物参考|家庭 scope、Evidence hash、授权 revision、撤回/删除规则；模型许可证不提供用户数据授权|

任何一个层级通过，都不能替代另外三个层级。

## 8. 服务器资源配置草案

```text
CPU 路径（可并行但限流）
  SHA-256 / pHash / EXIF
  RapidOCR + PP-OCR
  YuNet + SFace 候选

GPU 路径（首轮严格串行）
  Chinese-CLIP 或 SigLIP2，batch=1, concurrency=1
  SenseVoiceSmall，batch=1, concurrency=1
  两者不同时常驻，直到显存峰值 Gate 通过

API 路径
  qwen3.7-flash-2026-07-15
  仅困难语义、冲突、故事标题/摘要
```

建议的首轮资源 Gate（仍需 Integrator 在正式 run manifest 中冻结）：

- GPU 组件逐一冷启动、热运行和卸载；记录 `peak_vram_mib`、p50/p95、失败类型和进程 RSS；
- 给 CUDA runtime、解码和突发请求保留显存余量，不以“刚好不 OOM”作为通过；
- 初始 GPU worker concurrency 固定为 1；未跑压力测试前不提高；
- ASR 与 embedding 同时到达时进入队列，不并发抢占同一张卡；
- 任一模型加载失败时返回组件级 `MODEL_UNAVAILABLE`，按已确认的部分成功策略降级；
- `/readyz` 只有在当前 release 指定的全部必需 artifact、hash、许可证清单和实际模型加载都通过后才返回 ready。

## 9. 明确排除项

|排除项|原因|
|---|---|
|未固定 revision 的 `master` / `main` / `latest`|内容可变，无法复现或回滚。|
|自动联网下载模型|会绕过来源、hash、许可证与回滚 Gate；正式服务必须 `local_files_only`。|
|InsightFace 公共预训练模型包|官方文档对公共模型包存在非商业研究使用边界；本轮不以它替代 YuNet/SFace。|
|本地部署大 VLM|约 5.81 GiB vGPU 不适合作为本轮稳定内部服务基线；Qwen Flash 继续走 API。|
|embedding 相似度直接合并故事或确认人物|相似度只用于 Top-K 召回，不是身份或事件事实。|
|在产品客户端保存模型/API 密钥|凭据只能留在服务端 secret storage。|

## 10. 正式 `VERIFIED` 前的冻结清单

- [x] PP-OCRv5 det/rec/cls 三个服务器实际文件 SHA-256 与 RapidOCR 官方 `v3.9.2` 期望值完全一致。
- [x] PP-OCRv5 在 12 张固定合成图片上完成 `run-003`：20/20 required token，0 自动重试，CPU p95 3604.762 ms。
- [x] feature-service HTTP smoke 真实加载三个 PP-OCRv5 ONNX，并返回 OCR 结果；证据文件 SHA-256 已记录。
- [ ] 用真实手机照片/老照片补做 OCR 效果与延迟集；在完成前不得把合成 Gate 写成真实准确率。
- [ ] 将当前 `unreleased/unknown` 的服务身份补齐为 Git SHA、release manifest digest 与 dependency lock digest。

- [ ] 为每个 runtime 记录精确版本、完整源码 commit、package/wheel SHA-256。
- [ ] 为每个模型记录不可变 revision；tag 仍要解析成具体 commit。
- [ ] 生成 artifact 全文件清单并逐文件计算 SHA-256；与官方值可对照的必须完全一致。
- [ ] 将 `LICENSE`、`NOTICE`、模型卡、模型专用协议存入 release provenance 目录。
- [ ] Chinese-CLIP `v1.0.1`、SenseVoiceSmall `master` 均解析为不可变服务端 revision。
- [ ] 关闭 SenseVoiceSmall 页面 Apache 标签与 FunASR Model License 1.1 的适用关系记录。
- [ ] 完成 SFace 训练数据/商业使用合规复核；未关闭前只做内部受控评测。
- [ ] 在同一固定数据集比较 PP-OCRv5/v6 与 Chinese-CLIP/SigLIP2，不因下载成功而选型。
- [ ] 真实运行 OCR、embedding、face、ASR 的质量、延迟、CPU/RAM/vGPU 峰值 Gate。
- [ ] Qwen 请求固定模型快照、地域、参数、Prompt、Schema、预算、0 自动重试和响应模型审计。
- [ ] release manifest、provenance manifest、依赖 lock、模型目录 digest 与代码 Git SHA 绑定。
- [ ] 全栈只依赖接口契约；模型实现可以在不改变外部契约的情况下回滚或替换。

## 11. 官方一手来源

- RapidOCR source/license/model provenance: <https://github.com/RapidAI/RapidOCR>
- RapidOCR 3.9.2 release: <https://github.com/RapidAI/RapidOCR/releases/tag/v3.9.2>
- RapidOCR official model manifest: <https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml>
- RapidOCR post-release model license mapping on `main`: <https://github.com/RapidAI/RapidOCR/blob/main/python/MODEL_LICENSES.md>
- RapidOCR upstream clarification discussion: <https://github.com/RapidAI/RapidOCR/discussions/736>
- Chinese-CLIP code: <https://github.com/OFA-Sys/Chinese-CLIP>
- ModelScope Chinese-CLIP model page: <https://modelscope.cn/models/damo/multi-modal_clip-vit-base-patch16_zh>
- ModelScope Chinese-CLIP revisions API: <https://www.modelscope.cn/api/v1/models/damo/multi-modal_clip-vit-base-patch16_zh/revisions>
- Google big_vision / SigLIP2: <https://github.com/google-research/big_vision>
- SigLIP2 exact model revision: <https://huggingface.co/google/siglip2-base-patch16-224/tree/0ad8c6e0ff16615356a08a1ad8c8bbc8930c434e>
- OpenCV Zoo YuNet: <https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet>
- OpenCV Zoo SFace: <https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface>
- OpenCV Zoo SFace commercial-use/training-data clarification issue: <https://github.com/opencv/opencv_zoo/issues/313>
- FunASR code license: <https://github.com/modelscope/FunASR/blob/main/LICENSE>
- FunASR model license: <https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE>
- SenseVoiceSmall model page: <https://modelscope.cn/models/iic/SenseVoiceSmall>
- SenseVoiceSmall revisions API: <https://www.modelscope.cn/api/v1/models/iic/SenseVoiceSmall/revisions>
- Qwen3.7 Flash model page: <https://help.aliyun.com/zh/model-studio/qwen3-7-flash>
- Alibaba Cloud Model Studio agreements: <https://help.aliyun.com/zh/model-studio/related-agreements/>
- Alibaba Cloud Model Studio service notes: <https://help.aliyun.com/zh/model-studio/bailian-service-notes>
- Alibaba Cloud Model Studio pricing: <https://help.aliyun.com/zh/model-studio/model-pricing>

来源核对日期：2026-10-02。供应商条款和模型页面会变化，正式 release 时必须重新快照并记录访问日期。

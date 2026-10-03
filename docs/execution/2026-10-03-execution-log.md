# 2026-10-03 SGX 执行记录

## 本日目标

把 VirtAI 上的模型与依赖获取改成严格持久化流程，恢复容器后无需重新下载；在此基础上继续冻结 OCR、embedding、人物候选和 ASR 组件。

## 用户决策

- 所有通过网络获取的模型权重、Python wheel、源码归档、模型卡、许可证与下载缓存必须保存在持久盘；
- `/quota/sgx-classification` 只保存可从持久制品离线重建的虚拟环境和生成缓存；
- `/tmp/sgx-classification/jobs` 只保存有生命周期上限的单任务输入和临时输出。

## 已完成事实

### 持久化下载策略

- 提交 `8c4b887`（`chore(classification): enforce persistent download caches`）已把持久下载缓存约束落入部署脚本、环境变量示例和部署测试；
- 持久根固定为 `/gemini/code/sgx-classification`；
- 新增策略版本 `classification-download-persistence.1`；
- Hugging Face、Transformers、ModelScope、ONNX、Torch、pip、uv、XDG 与 virtualenv 下载缓存全部指向持久根；
- Worker 启动时校验这些路径必须位于持久根内，否则 fail closed；
- 正式运行继续使用 `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1` 和 `SGX_ALLOW_MODEL_DOWNLOADS=false`，禁止运行期静默下载。

远程目录边界保持不变：`/gemini/code/sgx-classification` 保存模型、wheel、源码包、许可证、下载收据、manifest、日志和后续正式评测制品；`/quota/sgx-classification` 只能保存可由持久制品离线重建的环境与缓存；`/tmp/sgx-classification/jobs` 只能保存有生命周期上限的任务临时文件。

### 工程验证

- `npm run test:classification`：`472/472` 通过，`0` 失败，`0` 跳过；
- `npm run typecheck`：通过；
- 部署/回滚 fixture：通过；
- `git diff --check`：通过；
- VirtAI Feature Service 当前 r5 源码快照 pytest：`32/32` 通过；使用 Python 3.10 隔离 venv，从持久 wheelhouse 离线安装依赖；
- Python 测试 wheelhouse 共 24 个文件、10,799,860 bytes，并保存逐文件 SHA-256、摘要和测试日志。
- 已生成全栈集成候选包 `v0.1.1-20261002`，共 255 个文件、2,650,940 bytes；本地密钥扫描与 ZIP 完整性检查通过；
- 交付包 SHA-256 为 `767dc190f1c78609668d995dc8608dc24a7b4ba2b6950a8cca052f75b4e53abd`；已上传到持久目录 `/gemini/code/sgx-classification/shared/downloads/deliveries/` 并在远端复核 hash 与 ZIP 完整性；旧 `v0.1.0` 未覆盖。

以上结果证明当前契约、adapter、部署路径和持久化策略的工程行为；不证明真实家庭图片准确率、人物身份可靠性、用户收益或生产 SLA。

### 已冻结并真实运行的本地能力

| 能力 | 固定实现 | 目标设备 | 当前证据 |
|---|---|---|---|
| OCR | RapidOCR 3.9.2 + PP-OCRv5 mobile | CPU | 合成图识别出 `2018` |
| 图文 embedding | `damo/multi-modal_clip-vit-base-patch16_zh`，revision `e6d9ca1...` | `cuda:0`，FP16，batch=1 | 图片和中文文本均输出有限、归一化 512 维向量 |
| 人脸候选 | YuNet + SFace，OpenCV Zoo commit `47534e27...` | CPU | 多人图输出 7 个匿名 128 维候选；不输出姓名或关系 |
| ASR | SenseVoiceSmall revision `7bf45240...` + FunASR 1.4.16 + kaldi-native-fbank 1.22.3 | `cuda:0` | 3 段 16 kHz PCM 均输出非空中文文本 |

候选模型已从持久 staging 复制到
`/gemini/code/sgx-classification/shared/models/candidates`，共约 1.7 GiB。
注册表：
`/gemini/code/sgx-classification/shared/manifests/candidate-model-registry-20261003-r1.json`
（SHA-256 `699e1b49c6195d83f475889d4767670b4a9a91ef5d786ff09b664e14c255a575`）。
复制采用加法式操作，staging、下载收据、许可证和旧失败记录均保留。

当前 Feature Service 源码以不可覆盖的 r5 快照保存到
`/gemini/code/sgx-classification/shared/downloads/source-packages/sgx-feature-service-source-20261003-r5.tar.gz`，
SHA-256 为
`2e66e369c07a286f3c7b6e2d48de4ceb5db9fe0ebd21cd3907d8bfcd90b872da`。
从该持久快照解包后的 `32/32` pytest 日志 SHA-256 为
`b1b2d25b72a9d852e4c6fc7a6b5a142deba99cc5d649de317f7e14a348b19974`；
测试未联网，`/quota` 只使用现有可离线重建 venv。

### 正式混合评测准备状态

- 当前共享工作树已实现跨 `exploration` / `validation` 的 campaign ledger，以及 pointer / approval v2 绑定；后续真实运行和版本状态见下方“Qwen3.7 Flash 真实探索与方向纠偏”；
- campaign 总硬上限维持为 `150` 次真实 Provider 调用、总费用不超过 `¥25`、自动重试 `0`；单案例失败继续其他独立案例，授权、预算、模型或 scope 级错误停止全局执行；
- 经当前数据逐对复核，关系固定分母更正为 `same / different / unknown = 7 / 11 / 3`；旧的 `11 / 7 / 3` 口径不再使用；
- 核心正式计划为 `51` 次真实 Provider 调用加 `4` 个确定性产品评估，共 `55` 个评估单元。两类调用分别记账，确定性评估不占 Provider 调用额度；
- 本节记录的是正式运行前的准备快照；新的付费 Provider 运行事实见下方更新，不再使用“尚未运行”的旧状态判断当前进度；
- `472/472` 只证明当前工程契约与门禁行为，不构成真实家庭图片准确率、人物身份可靠性、真实老人语音准确率或产品就绪证据。

### ASR 失败、修复与结果

首轮 SenseVoice 真实运行成功加载权重，但在第一条音频的 fbank
阶段失败，原因是统一环境缺少 `torchaudio` 或
`kaldi-native-fbank`。失败证据保留为：

`/gemini/code/sgx-classification/shared/manifests/component-smoke-asr-20261003-r1.failure-01.json`

修复选择 FunASR 官方 `knf` fallback，固定
`kaldi-native-fbank==1.22.3`，避免向既有 CUDA/Torch 环境再加入一套
`torchaudio`。wheel SHA-256 为
`c710b62442a43720db853cbafbf57ea3f920b593128dfb8fb88e08d6a8225772`，
许可证为 Apache-2.0，wheel、缓存、下载日志和安装日志均在持久盘。

修复后的 ASR r2 通过，结果 SHA-256 为
`fd9fa96147e3814e006228c3d6e8d3f3e1fe6b6fe1bdcdd3896e2cd51ae20c82`。
3 个合成 TTS 样本的字符序列相似度分别为 `0.837838`、`0.968750`、
`0.666667`；该数值只用于发现转写偏差，不是老年真实语音准确率。

### 统一服务集成失败、修复与结果

首轮 loopback HTTP 测试中 OCR 已返回 200，但 embedding 首次加载返回
`MODEL_LOAD_FAILED`。内部诊断定位为统一环境遗漏 ModelScope 运行依赖
`addict`；随后对比已通过的 embedding 环境与统一环境，一次性补齐
`addict==2.4.0` 和 `attrs==25.4.0`。r1 失败结果与原始内部异常均保留。

修复后的统一环境依赖快照：

- 路径：`/gemini/code/sgx-classification/shared/manifests/feature-service-all-py310-20261003-r2.freeze-final-r2.txt`
- SHA-256：`9099dff907e2ac93c25be57eb1f3087d0d6c7946853b2379f9edc6a2062aef56`
- `pip check`：无破损依赖。

全能力 HTTP r2 在同一进程、同一 5.81 GiB vGPU 上通过：

- `/healthz` 为 200；未加载模型时 `/readyz` 为预期 503；
- OCR、image embedding、text embedding、face embeddings、ASR 均为 200；
- 所有组件加载后 `/readyz` 为 200/`ready`；
- 总冷路径耗时约 `112300.88 ms`，其中包含 embedding 与 ASR 权重冷加载；
- 结果 SHA-256：`ba1d9babca1d8772a7b2a1f789842bc996a5f25b3e6174a2fa68cc0a510587b9`。

### 结论边界

目前已经证明四类本地模型可在目标服务器离线加载，并能通过同一个
内部 HTTP 契约被 Worker 调用。人物链只产生匿名候选；具体姓名、亲属
关系和稳定人物身份仍需授权、参考照片积累与产品确认策略。当前素材为
合成数据，不能据此声称真实家庭图片准确率、人物身份可靠性、真实老人
语音准确率、生产 SLA 或用户收益。

## 准备阶段的下一步 Gate（已由下方真实探索更新）

1. 冻结并生成 formal campaign，包含 `exploration` / `validation` manifest、pointer、approval、dataset root 和累计账本绑定；
2. 在任何付费调用前，把 formal campaign 完整复制到 `/gemini/code/sgx-classification` 持久盘并复核 hash、权限、`150` 次 / `¥25` / `0` 重试上限；
3. 提交并复核当前尚未提交的 campaign ledger、pointer / approval v2 与失败分类改动，再运行本地 Node 契约测试、TypeScript typecheck、部署 fixture 和交付包自检；
4. Gate 通过后，按 `51` 次真实 Provider 调用加 `4` 个确定性产品评估的固定计划执行正式混合链评测；
5. 用当前真实配置重建全栈交付包，包含架构、接口、环境变量、持久盘布局、启动/回退命令和证据索引；
6. 全栈工程师接入对象存储、业务数据库、outbox/lease/CAS 和真实相册页面后，进入 T1 产品联调；
7. SFace 预训练权重的商业/训练数据来源审查完成前，只用于内部评估。

## Qwen3.7 Flash 真实探索与方向纠偏

### 为什么执行

工程门禁已经足以保护授权、预算、版本和持久化边界，继续扩大纯工程回归不能回答“真实模型能否完成分类与归纳”。本轮因此把主循环改为：真实模型批量运行、按产品结果分析失败、只修复可泛化根因、再做有界真实复测。没有因单个样本去修改真值或加入硬打分阈值。

### 真实执行事实

- 模型固定为 `qwen3.7-flash-2026-07-15`，人物匹配开启，自动重试为 `0`；
- r5：8 次，因相对时间被错误表示为绝对时间而停止；账本费用 `¥0.054257`；
- r6：22 次，关系输出在 1024 token 上限处截断两例；账本费用 `¥0.268340`；
- r7：17 次，模型漏掉应返回的人物关系，严格 coverage guard 停止；账本费用 `¥0.126701`；
- r8：31/31 次固定探索全部调用完成，18 张不同图片、44 次图片发送、输入 136128 token、输出 23438 token、墙钟约 230 秒、账本费用 `¥0.275856`；无截断、限流、授权、预算或模型版本错误；结束标记为 `UNKNOWN_FACE`；
- r9b：针对 r8 的“有人人像与无人静物配对”执行 3 次真实调用，3/3 完成、无错误、无人工项、费用 `¥0.020707`；模型只返回事件关系，没有再生成虚构 faceId；
- 上述 campaign 累计 81 次真实 Provider 调用，账本费用 `¥0.745861`；原始总授权剩余 69 次、`¥24.254139`。旧失败与每轮原始响应均保留，未覆盖。

主要证据：

- r8 报告：`classification-lab-data.local/real-batch/campaigns/sgx_formal_v2_20261003_r8/results/exploration-real-r8/REPORT.md`；
- r8 原始响应：同目录 `provider-responses.jsonl`；
- r9b 报告：`classification-lab-data.local/real-batch/campaigns/sgx_targeted_no_face_20261003_r9b/results/targeted-real-r9b/REPORT.md`；
- 每轮累计调用和费用以对应 `campaign-ledger.json` 为准。

### 真实模型发现

1. **运行链已经真实可用**：Qwen 能接收图片、用户文字和 final ASR，返回人物候选、时间、地点、事件、场景及图间事件/人物关系；r8 的 31 次调用全部获得指定模型的 usage 与 response id。
2. **关系输出不能只靠扩大 token**：提升 relate 上限和增加 stage-specific prompt 后，r8 不再发生截断，但多人关系会产生大量组合与解释，速度和 token 成本明显高于单图提取。正式产品应由本地 face/image embedding 先召回少量候选，VLM 只判断困难关系与故事语义。
3. **人物链需要 adapter 保护**：r8 把 `personMatchingEnabled=true` 传给一张有人、一张无人的配对，模型为无人照片虚构 faceId。`e784b68` 改为只有双方存在人物候选时才请求人物匹配，并在模型仍返回不存在 faceId 时只隔离该人物边，不丢失事件与五维结果。r9b 真实复测通过。
4. **事件语义仍有模型弱点**：三张相同老自行车照片/裁切/翻拍中，模型对三个配对给出 `same / different / same`，形成传递冲突；系统安全地阻止了不一致合并。三张同一天社区花园照片则全部正确归为同一事件，且与旧旅行照保持分离。
5. **当前数字 scorer 不能直接当准确率**：人物真值只覆盖少数照片且检测框口径不同；上传时间、扫描时间和 OCR 尚未完整注入本轮 VLM manifest；部分场景标签需要应用 taxonomy adapter；相对时间 aliases 也未完全归一。因此 r8 的 facet/person 数字只用于发现问题，不能作为上线 Gate。

### 已提交的通用修复

- `b908e33`：隔离非法模型时间输出，保留其他维度；
- `93dd4df`：关系阶段使用精简输出指令，并把上限从 1024 提升到 2048；
- `4a1cff9`：模型漏答人物关系时降级为未确认，保留分类结果；
- `e784b68`：只对双方都有人物候选的配对启用人物关系，并隔离未知 faceId。

每次只运行 TypeScript 编译和 2–3 个直接相关用例，然后进入真实模型验证；没有再运行 472 项全量回归。

### 更新后的下一步优先级

1. 把 VirtAI 的 RapidOCR、image/text embedding、YuNet/SFace 和 SenseVoice 输出真正注入 Stage A，而不是继续让 VLM 独自承担 OCR、全量人物组合和所有召回；
2. 修正 formal evaluator 的 taxonomy、相对时间 alias、系统时间来源和人物框口径，再运行封闭 validation；
3. 在 `/classification-lab/real` 接入多轮多图、文字、真实音频 ASR 和持久化，完成用户可操作的 T0/T1 本地体验；
4. 只在上述混合链和页面完成后制作新的全栈交付包。当前包不能描述为最终算法交付。

## 真实混合 T1 与全栈交付完成计划冻结

用户要求把剩余目标、执行顺序、验收门槛和 ZIP 交付边界写成文档并按文档执行。新计划已写入：

`docs/superpowers/plans/2026-10-03-classification-hybrid-t1-handoff-completion-plan.md`

计划保留已有组件与真实运行成果，不重复搭建 Feature Service、Worker、Prompt 或单图真实页面。当前实现顺序冻结为：

1. 在任何 face embedding 调用前校验逐图片人物授权；
2. 将 face embedding 形成匿名候选，并增加同 household/subject 的跨轮历史检索契约与文件型参考实现；
3. 增加原始语音 ASR 前置步骤，统一多图、多轮、文字绑定、人物授权和真实 Qwen 页面；
4. 修正 evaluator 的 taxonomy、时间来源、OCR 注入和框语义，再做真实混合探索与冻结 validation；
5. 完成页面人工验收后更新算法、部署、接口和验证文档，生成新的 T0/T1 全栈交付 ZIP。

本计划的完成定义要求真实 Qwen 与真实 Feature Service 在同一完整链中运行，并同时证明跨轮检索、授权先于人脸计算、撤权/隔离/迟到结果门禁和原始语音到 final ASR。产品业务数据库、对象存储、pgvector、正式账号鉴权和队列仍由全栈工程师在 T2 接入。

## T1 共享真实调用总账本

### 发现与修复

既有 r5、r6、r7、r8、r9b 分别有自己的 campaign ledger，后续批次通过手工下调下一批上限维持累计 `150` 次 / `¥25`。T1 网页 Worker 链此前只有单任务 `40` 次 / `¥5` 上限，没有读取这些历史账本，因此页面多轮调用存在绕过全局剩余额度的风险。

新增 `classification-real-call-authorization.1` 与 `classification-real-call-ledger.1`：

- 以既有五份 ledger 的哈希为来源，把累计起点固定为 `81` 次、`¥0.745861`；
- 页面和后续 Worker 任务共享剩余 `69` 次、`¥24.254139`；
- `stage_a_real` 任务在领取前预留单任务全部请求与费用上限，未配置、过期、模型不符或额度不足时拒绝领取；
- 完成和明确的模型调用前失败按实际用量结算并释放余额；
- 模型已经可能调用但无法确定用量的失败或取消按完整预留额度记账；
- 完成、失败和取消都返回累计账本状态，T1 页面显示已用和剩余额度；
- Worker 在模型完成后、结果上传或终态提交失败时保留已知 usage，避免把已发生的真实调用误记为零；
- 配置与账本均不包含 API key，密钥仍只由 Keychain/服务端 secret storage 提供。

### 验证与边界

- `npm run typecheck`：通过；
- `npm run test:classification`：`518/518` 通过，`0` 失败、`0` 跳过；
- 测试覆盖历史余额导入、预留/结算、未知用量保守记账、超额后停止、无总授权时真实 Worker 不领取任务，以及调用前失败释放余额；
- 本节没有发起新的外部请求，累计真实调用仍为 `81` 次、`¥0.745861`；
- 工程门禁通过不代表真实模型产品效果。下一动作是把该授权配置和当前 Worker release 部署到持久盘，完成一条真实图片/文字/ASR/本地特征/历史召回/Qwen/持久化 canary。

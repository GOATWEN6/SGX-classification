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

- 当前共享工作树已实现跨 `exploration` / `validation` 的 campaign ledger，以及 pointer / approval v2 绑定与相关测试；这些改动尚未提交，不属于 `8c4b887`，也不能按已发布能力对外描述；
- campaign 总硬上限维持为 `150` 次真实 Provider 调用、总费用不超过 `¥25`、自动重试 `0`；单案例失败继续其他独立案例，授权、预算、模型或 scope 级错误停止全局执行；
- 经当前数据逐对复核，关系固定分母更正为 `same / different / unknown = 7 / 11 / 3`；旧的 `11 / 7 / 3` 口径不再使用；
- 核心正式计划为 `51` 次真实 Provider 调用加 `4` 个确定性产品评估，共 `55` 个评估单元。两类调用分别记账，确定性评估不占 Provider 调用额度；
- 本轮没有执行新的付费 Provider 调用，正式 campaign 尚未生成或运行；
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

## 下一步 Gate

1. 冻结并生成 formal campaign，包含 `exploration` / `validation` manifest、pointer、approval、dataset root 和累计账本绑定；
2. 在任何付费调用前，把 formal campaign 完整复制到 `/gemini/code/sgx-classification` 持久盘并复核 hash、权限、`150` 次 / `¥25` / `0` 重试上限；
3. 提交并复核当前尚未提交的 campaign ledger、pointer / approval v2 与失败分类改动，再运行本地 Node 契约测试、TypeScript typecheck、部署 fixture 和交付包自检；
4. Gate 通过后，按 `51` 次真实 Provider 调用加 `4` 个确定性产品评估的固定计划执行正式混合链评测；
5. 用当前真实配置重建全栈交付包，包含架构、接口、环境变量、持久盘布局、启动/回退命令和证据索引；
6. 全栈工程师接入对象存储、业务数据库、outbox/lease/CAS 和真实相册页面后，进入 T1 产品联调；
7. SFace 预训练权重的商业/训练数据来源审查完成前，只用于内部评估。

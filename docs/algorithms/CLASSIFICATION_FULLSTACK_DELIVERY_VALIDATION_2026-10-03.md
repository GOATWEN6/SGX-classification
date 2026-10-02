# SGX 自动分类全栈交付验证记录（2026-10-03）

> 状态：`internal_release_candidate`
> 适用范围：T0 算法本地验证与 T1 全栈接入
> 结论边界：工程链可运行，不等于真实用户准确率、生产 SLA 或正式发布。

## 1. 本版已经验证的能力

|层级|验证结果|证据|
|---|---|---|
|持久化|模型、wheel、源码快照、许可证、固定素材、工具、日志和结果均位于 `/gemini/code/sgx-classification`；`/quota` 仅放可离线重建 venv|`classification-download-persistence.1` 与候选注册表|
|OCR|RapidOCR 3.9.2 + PP-OCRv5 mobile 在 CPU 加载并经 HTTP 返回区域和文本|`component-smoke-feature-service-http-20261003-r2.result.json`|
|图文 embedding|Chinese-CLIP 固定 revision 在 `cuda:0` 输出 512 维归一化 image/text 向量|同上|
|人物候选|YuNet/SFace 输出匿名 128 维人脸向量，不输出姓名或关系|同上|
|ASR|SenseVoiceSmall + FunASR 1.4.16 + kaldi-native-fbank 1.22.3 处理 PCM WAV 并返回中文文本|同上及 `component-smoke-asr-20261003-r2.result.json`|
|统一服务|五个 feature endpoint 在同一进程内均返回 200，最终 `/readyz` 为 `ready`|HTTP r2 结果 SHA-256 `ba1d9babca1d8772a7b2a1f789842bc996a5f25b3e6174a2fa68cc0a510587b9`|
|Python 代码|当前 r4 源码快照在目标环境单元/契约测试 `32/32` 通过|`feature-service-source-20261003-r4.pytest.log`|

## 2. 运行配置

- 模型注册表：
  `/gemini/code/sgx-classification/shared/manifests/candidate-model-registry-20261003-r1.json`
- 注册表 SHA-256：
  `699e1b49c6195d83f475889d4767670b4a9a91ef5d786ff09b664e14c255a575`
- Python 依赖快照：
  `/gemini/code/sgx-classification/shared/manifests/feature-service-all-py310-20261003-r2.freeze-final-r2.txt`
- 依赖快照 SHA-256：
  `9099dff907e2ac93c25be57eb1f3087d0d6c7946853b2379f9edc6a2062aef56`
- `pip check`：无破损依赖。
- 当前源码快照：
  `/gemini/code/sgx-classification/shared/downloads/source-packages/sgx-feature-service-source-20261003-r4.tar.gz`
- 源码快照 SHA-256：
  `48625ac441958779ad851ed649b89c60a03d67735c0bcc4ff3b0a7d387217fb6`
- r4 测试日志 SHA-256：
  `2f6e8ffe38ba683dd75f1eb11ef90897fa88788101d5279f8d2b48d8c86c778d`
- r4 测试过程未联网；`/quota` 中仅使用现有可离线重建 venv。
- vGPU：`B1.gpu.small`，5.81 GiB，单并发。

全能力冷路径约 112 秒，包含 Chinese-CLIP 和 SenseVoice 首次权重加载。
产品应采用异步 Job，并让服务常驻/预热。该值来自一次固定合成冒烟，不是
p95 或 SLA。

## 3. 本轮发现并修复的问题

1. **ASR fbank 依赖缺失**：模型加载成功后在特征提取时报错。补入 FunASR
   官方 `knf` fallback `kaldi-native-fbank==1.22.3`；首轮失败保留。
2. **统一环境漏装 ModelScope extra**：单独 embedding 环境通过，但统一服务
   缺 `addict`。通过环境差异审计一次性补入 `addict==2.4.0` 与
   `attrs==25.4.0`；HTTP r1 失败和内部 traceback 保留。
3. **候选目录首次创建检查顺序错误**：晋级工具在写入前失败。修正为词法范围
   校验、创建父目录、真实路径复核；r2 完成逐文件复制与 hash 校验。

这些问题都发生在依赖/部署集成层，不是 Prompt 或分类标签错误。

## 4. 全栈工程师可依赖的接口

Feature Service 只监听 Worker 同机 loopback：

```text
GET  /healthz
GET  /readyz
GET  /version
POST /internal/v1/features/ocr
POST /internal/v1/features/image-embedding
POST /internal/v1/features/text-embedding
POST /internal/v1/features/face-embeddings
POST /internal/v1/features/asr
```

产品浏览器不直接调用这些 endpoint。产品后端负责对象存储、Job/outbox、
lease、授权 revision 和结果 CAS；VirtAI Worker 下载单任务素材到 `/tmp`，
校验 hash 后调用本机 Feature Service，再把带版本的候选结果提交回产品后端。

## 5. 仍未完成的发布 Gate

- 20 个提交、固定真值和固定分母的 VLM 混合链正式评测；
- Chinese-CLIP Top-K 召回率及事件/人物候选消融；
- 真实老人语音、噪声、方言、长音频 ASR 质量；
- 授权真实人物跨年代/角度验证；
- SFace 预训练权重商业与训练数据来源审查；
- 产品对象存储、数据库、outbox/lease/CAS 和智能相册 UI 的 T1 联调；
- 热态 p50/p95、并发、显存峰值、稳定性和故障恢复压测。

因此本版适合交给全栈工程师开始 T1 接入，也适合产品负责人在 T0 页面做
算法功能验证；尚不适合向真实用户公开发布。

# SGX 自动分类与归纳：全栈交付包 README

> 包类型：`internal_release_candidate`
> 交付版本：`v0.2.1-20261003`
> 目标：让全栈工程师在新版产品仓库中实现真实上传、异步 Job、云端 Worker 和智能相册结果接入。

## 1. 先读哪些文件

1. [`ALGORITHM_ARCHITECTURE_AND_FUNCTIONS.md`](ALGORITHM_ARCHITECTURE_AND_FUNCTIONS.md)：完整算法目标、输入、流程、模型、规则、输出和产品边界。
2. [`FULLSTACK_INTEGRATION_GUIDE.md`](FULLSTACK_INTEGRATION_GUIDE.md)：产品 API、Worker 控制面、签名 URL、错误码和验收步骤。
3. [`MODEL_PROVENANCE_AND_RELEASE_GATES.md`](MODEL_PROVENANCE_AND_RELEASE_GATES.md)：模型选型、开源来源、许可、hash 和当前 Gate。
4. `contracts/README.md`：所有 JSON Schema 的关系。
5. `deploy/classification-worker/README.md`：VirtAI 隔离目录、激活和回滚。

## 2. 现在能交付什么

- 可复制的 TypeScript 分类核心：Evidence 校验、Stage A、稀疏召回、规则组织和 StoryUnit。
- 可运行的 Node Worker：lease、heartbeat、签名下载、hash 校验、Feature Service、Stage A 子进程、结果上传、complete/fail/cancel-ack 和清理。
- localhost-only Python Feature Service：真实 RapidOCR、Chinese-CLIP、匿名人脸候选和 SenseVoice ASR 的稳定接口、离线 adapter 与统一进程验证证据。
- JSON Schema：输入、Job、结果、复核、混合特征和 Worker 控制面，包含 execution-context。
- 实验页和 BFF 参考实现：用于本地上传和真实模型功能测试，不替代产品后端。
- 自动化门禁：Node/TypeScript、Worker、部署回滚、Python、密钥扫描和 diff 检查。

## 3. 不能从本包直接得出的结论

- 不能把测试通过解释为真实家庭照片准确率。
- 不能把 OCR 合成图结果解释为真实手机照片 OCR 准确率。
- 不能把内部候选 artifact 或合成冒烟结果解释为真实用户准确率、可靠身份或正式生产发布。
- 不能让浏览器直接调用 VirtAI、OCR、embedding 或模型供应商。
- 不能把 AI 候选直接写入长期 Memory。
- 不能仅凭这个 ZIP 上生产；产品数据库、对象存储、鉴权、OpenAPI、队列/lease 和监控由产品后端实现。

## 4. 目录说明

```text
contracts/                         JSON Schema 和接口契约
deploy/classification-worker/      云端 Worker、部署、回滚和测试
services/classification-feature-service/
                                   OCR/embedding/face/ASR 内部服务
src/lib/algorithms/classification/ 分类核心代码
src/app/api/classification-lab/    本地 BFF 参考
src/app/classification-lab/        本地测试页面参考
harness/classification/            契约、行为和评测回归
docs/algorithms/                    完整算法与证据文档
docs/superpowers/                   当前冻结 Spec 和执行计划
figures/                            架构图 PNG、Mermaid 源码和预览
scripts/                            类型生成、统一测试和 Fake/Stage A 入口
```

根目录还包含：

- `ALGORITHM_ARCHITECTURE_AND_FUNCTIONS.md`
- `VALIDATION_REPORT.md`
- `PACKAGE_METADATA.json`
- `MANIFEST.sha256`

## 5. 本地验证

环境：Node.js 22、npm、Python 3，以及已安装包内 `requirements*.in` 所列测试依赖的隔离 Python venv。正式部署需另行生成带 hash 的目标平台完整依赖锁。

```bash
npm ci
npm run test:classification:delivery
```

统一门禁依次执行：

1. Schema/types 生成一致性；
2. 全部分类 harness 与真实 Worker/Stage A 子进程回归；
3. TypeScript typecheck；
4. 部署目录、原子激活和回滚 fixtures；
5. Python Feature Service pytest；
6. 分类代码、服务、文档和部署包密钥扫描；
7. `git diff --check`。

如果只想先验证契约和 Worker：

```bash
npm run test:classification
bash deploy/classification-worker/tests/deployment-scripts.test.sh
PYTHONPATH=services/classification-feature-service/src \
  python3 -m pytest -q services/classification-feature-service/tests
```

## 6. 产品如何接入

建议产品路径：

```text
浏览器上传 -> 产品后端保存对象 -> 创建 Job -> Worker 拉取
-> OCR/embedding/VLM/组织 -> 上传结果 -> 产品后端事务接收
-> 智能相册/待整理/搜索 -> 用户确认/纠错 -> reference/MemoryCandidate
```

产品后端至少实现以下语义：

1. 上传初始化；
2. 上传完成复验；
3. 创建分类 Job；
4. 查询 Job；
5. 查询当前结果；
6. 提交复核动作；
7. 撤回/删除 Evidence。

Worker 内部协议至少实现：

- `lease`
- `execution-context`
- `heartbeat`
- `complete`
- `fail`
- `cancel-ack`

具体路径、字段和示例在全栈接入手册中。产品端 URL 可以适配现有后端，但字段语义、幂等、scope、授权 revision 和 late-result CAS 不能丢失。

## 7. 全栈工程师需要替换的边界

|参考实现|在产品中替换为|
|---|---|
|实验室文件存储|正式数据库、对象存储和事务|
|loopback BFF|产品鉴权后的 API|
|内存/文件 Job 状态|Job 表、outbox、lease 和恢复机制|
|本地页面动作|产品智能相册、待整理和复核 UI|
|测试 signed URL|对象存储短时读写 URL|
|环境变量 secret|正式 secret storage|

算法核心、Schema、Prompt/Guard、错误码和状态语义应直接复用或保持兼容。

## 8. 第一轮联调完成标准

- 单图、两图、五图和图文/ASR 组合都能创建异步 Job；
- Worker 无需 SSH 人工操作即可拉取并上报结果；
- 输出能展示 AI 标题、摘要、时间线和人物/时间/地点/事件/场景筛选；
- 用户原文可见，AI 结果明确标记；
- 取消、授权撤回、删除和过期租约都不会接收迟到结果；
- OCR 或 embedding 单组件失败时有 partial/error 记录，Job 不会静默造假；
- 双家庭和多主体数据不串联；
- 人物候选仅在逐图授权后产生，不输出猜测姓名或关系；
- 每次模型调用记录 model、Prompt、token、费用和延迟；
- 部署版本可按 manifest 激活和回滚。

## 9. 第二轮真实模型 Gate

全栈可以在第一轮联调期间并行接入，但开放内部用户前还要冻结：

- 中文 image/text embedding 的固定图库 Top-K 召回质量、并发和热态延迟基准；
- YuNet/SFace 授权后的真实跨年代人物候选验证，以及 SFace 商业/训练数据来源审查；
- SenseVoiceSmall/FunASR 的真实老人语音、噪声、方言和长音频质量/RTF/p95；
- Qwen3.7 Flash 固定分母功能矩阵、费用和延迟报告；
- 真实上传到结果展示的 T0/T1 端到端报告。

这些 Gate 的失败不会改变接口，但会决定对应 capability 能否在 Worker 的 capability 声明中开启。

## 10. 版本和变更规则

- 任何 Prompt、模型、taxonomy、规则或 Schema 变化都必须更新版本或 digest。
- 历史结果保留当时版本，不能重写成最新版本。
- `MANIFEST.sha256` 用于确认交付包未被修改。
- 本包不含 `.env`、API key、SSH key、真实用户媒体、模型权重、`node_modules` 或 Python cache。
- 当前包名中的 `internal-release-candidate` 必须保留，直到真实数据、产品链和发布 Gate 全部完成。
- 云端下载持久化策略为 `classification-download-persistence.1`：模型、wheel、源码包、许可证和下载缓存必须位于 `/gemini/code/sgx-classification`；`/quota` 仅承载离线可重建的 venv 与生成缓存。

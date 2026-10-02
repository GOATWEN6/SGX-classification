# 2026-10-02 SGX 执行记录

## 本日目标

把自动分类与归纳从单图/定点真实模型实验推进到可部署、可回滚的混合链：本地 OCR 与 embedding 做特征和候选召回，Flash VLM 处理困难语义、关系和故事摘要，完成后交给全栈进入 T2。

## 用户授权与产品决策

- 允许生成 SGX 专用 SSH 密钥并连接 VirtAI；
- 允许在隔离目录配置 OCR、embedding 和必要运行环境；
- 要求配置前先参考成熟开源项目并结合 30–50 用户首批规模；
- 要求执行真实模型的完整 T0/T1 功能验证，并留下全栈调用接口；
- 真实模型实验采用预注册分母、费用和停止条件，不把合成数据称为真实准确率。
- 正式产品调用采用 worker-pull；SSH 只用于部署和调试；
- 本轮交付为最多 10 名内部用户可真实使用的云端服务，不承诺公网生产高可用；
- 产品现有文件存储保存权威素材，VirtAI 只保留任务临时副本；
- 同时支持原始音频经云端 ASR 和直接复用产品 final ASR；
- 人物候选能力开启，实名、关系和长期 Memory 仍使用独立确认门；
- 采用组件级部分成功；授权、scope、hash 与跨家庭隔离失败时安全停止。

## 已完成事实

### 专用 SSH 身份

- 已用受保护的 SGX 专用身份通过 `BatchMode=yes` 连接远端；私钥未写入仓库、报告或日志；
- 已创建并核验三根 `0700` 隔离目录：`/gemini/code/sgx-classification`、`/quota/sgx-classification`、`/tmp/sgx-classification/jobs`；
- 已上传无凭据源码包到独立 staging，未激活正式 release，也未覆盖其他项目目录；
- 当前 `releases/` 与正式 `shared/models/` 仍为空，没有常驻分类服务进程。

### 远端适配器契约 Gate

- 最新 feature-service staging 包 SHA-256：`9d8ea75e69d93d9dd347b7bd2d4f5defdbb6982b5f26b36010dd28f9a5f1ac58`；
- 首轮远端 pytest 暴露测试夹具把 image/text embedding 写成不同模型，与共享跨模态模型约束冲突：9 failed、11 passed；
- 修正夹具后重新生成独立包并复测：20/20 passed；首轮失败包和记录保留，未覆盖；
- 该 Gate 证明本地文件路径、契约、错误处理和可选人物端点可运行，不证明真实 ONNX/embedding/ASR 模型已加载。

### Source Gate

- OCR 首选 RapidOCR + PP-OCRv5，ONNX Runtime CPU 优先；官方 PaddleOCR server 作为精度对照；
- feature-service 同时支持冻结的 SigLIP2 和 ModelScope Chinese-CLIP profile；最终主模型必须经中文召回、延迟和显存固定基准选择；
- 人物候选采用 YuNet 检测 + SFace embedding 的独立 profile，输出未命名候选，不直接输出姓名或关系；
- ASR 候选为 SenseVoiceSmall，仍需冻结权重、运行时和音频解码依赖；
- 向量先用 PostgreSQL + pgvector，按家庭和主体过滤后精确 Top-K；
- 不在首批引入 Qdrant、BentoML、Ray Serve 或本地大 VLM；
- 只参考 Immich/LibrePhotos 的架构边界，不复制未完成 license 审核的代码。

### Design Gate

- VirtAI 只作为无状态计算平面；产品后端保存 DB、对象、授权、任务和权威结果；
- 采用 worker-pull 和短时 signed URL；SSH 仅供运维；
- embedding 只召回候选，不能用相似度阈值直接合并故事；
- 每张新图最多一次 VLM extract，只有困难候选才进入 relate；每个 StoryUnit 至多生成一次标题摘要；
- 旧 `0.25/0.55/0.80` 不再作为 active 产品门槛。

### 本地工程门禁

- `npm run test:classification`：426/426 通过；
- `npm run typecheck`：通过；
- `npm run test:classification:secret`：通过；
- `JWT_SECRET` 使用进程级占位值时 `npm run build`：通过；占位值未持久化；
- `git diff --check`：通过。

这些只证明本地工程回归，不证明模型准确率、真实家庭效果或生产可用。

## 新增事实源

- [云端混合服务冻结 Spec](../superpowers/specs/2026-10-02-classification-cloud-hybrid-service-spec.md)
- [云端混合 T0/T1 执行计划](../superpowers/plans/2026-10-02-classification-cloud-hybrid-execution-plan.md)
- `scripts/classification-virtai-preflight.sh`：只读远端资源盘点，不安装或写入远端。

## 固定评测边界

- 20 个产品提交、53 条 Evidence、30 张图；
- 21 个关系：11 same、7 different、3 unknown；
- exploration 35 次真实请求，validation 20 次；
- 当前用户授权硬上限扩展为 150 次、总费用不超过 ¥25、0 自动重试；人物候选功能开启；正式 run manifest 仍需冻结实际计划分母，不能把上限当成必须消耗的次数；
- OCR 与 embedding 先执行零付费组件 Gate；
- validation 打开后不回改当前版本 truth、Prompt 或规则。

## 当前阻塞和下一步

当前 P0 阻塞是正式模型 artifact、依赖 lock、激活 release、常驻 Worker 和产品 control-plane 尚未形成一条可调用链。下一步先冻结模型来源、revision、hash 和许可证，完成真实 OCR/embedding/face/ASR 加载与性能 Gate，再激活 release；付费 VLM 批次必须使用新的固定 run manifest 和现有 150 次/¥25/0 自动重试授权。

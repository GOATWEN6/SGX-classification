# 2026-10-02 SGX 执行记录

## 本日目标

把自动分类与归纳从单图/定点真实模型实验推进到可部署、可回滚的混合链：本地 OCR 与 embedding 做特征和候选召回，Flash VLM 处理困难语义、关系和故事摘要，完成后交给全栈进入 T2。

## 用户授权与产品决策

- 允许生成 SGX 专用 SSH 密钥并连接 VirtAI；
- 允许在隔离目录配置 OCR、embedding 和必要运行环境；
- 要求配置前先参考成熟开源项目并结合 30–50 用户首批规模；
- 要求执行真实模型的完整 T0/T1 功能验证，并留下全栈调用接口；
- 真实模型实验采用预注册分母、费用和停止条件，不把合成数据称为真实准确率。

## 已完成事实

### 专用 SSH 身份

- 已生成 ED25519 专用密钥；私钥只保存在本机 `~/.ssh/sgx_virtai_ed25519`，未写入仓库、报告或聊天；
- 公钥 fingerprint：`SHA256:HX/+ADTvjcGYVLkJp2kSE2ZUBTUVpOygRLTo1XcdfEI`；
- 已使用 `BatchMode=yes` 试连远端；主机可达，但账号尚未安装该公钥，返回 `Permission denied (password,publickey)`；
- 因此尚未创建远端目录、安装依赖、读取模型或执行远端测试。

### Source Gate

- OCR 首选 RapidOCR + PP-OCRv5，ONNX Runtime CPU 优先；官方 PaddleOCR server 作为精度对照；
- embedding 首选 SigLIP2 Base 224，Chinese-CLIP ViT-B/16 影子对照；
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

- `npm run test:classification`：416/416 通过；
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
- 总计划 55 次，硬上限 60 次、总费用上限 ¥5、0 自动重试、人物身份匹配关闭；
- OCR 与 embedding 先执行零付费组件 Gate；
- validation 打开后不回改当前版本 truth、Prompt 或规则。

## 当前阻塞和下一步

唯一外部阻塞是远端账号尚未接受专用公钥。公钥安装后立即执行只读资源预检，依据真实 GPU/CPU、路径和已有模型冻结 deployment manifest；在此之前不盲装整套推理栈。

本地并行下一步是审查并提交当前 evidence-rule 改动，随后修正 truth v2.1，开始 text/OCR/embedding adapter。首个付费请求必须等 adapter 与零费用 Gate 完成并冻结 run manifest。

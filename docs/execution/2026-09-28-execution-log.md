# 2026-09-28 SGX 执行记录

## 本日目标

独立核验 `sgx-t0-photorealistic-synthetic-v3` 的实际产物，判断它能否支持 SGX 图文分类与归纳的完整产品测试，并修复审计过程中发现的阻断性本地工具问题。

## 已确认事实

- 数据集实际存在 40 个内容组、39 张 JPEG、25 份用户文字、16 份 final ASR 和 16 个 M4A 音频参考。
- 96 个素材文件、198 个校验条目、26/14 分区、七类组合和 20 个场景维度经独立复算一致；没有软链接、未登记文件或跨分区上游 bundle 复用。
- 39 张图片具有照片感，但全部源自已验收 v2 合成资产；16 段音频全部为 TTS，当前运行没有新增媒体或外部模型调用。
- v3 重新定义了内容组和 truth，却把 v2 acceptance 复用为 `reviewedBy`；上游媒体验收不能替代 v3 新真值的独立复核。
- v3 使用自定义 `specVersion=3.0.0` 和合成 schema；仓库没有把它接入 `classification-ingestion.2`、Stage A eval 或 T1 实验台的可执行 adapter。
- 真实数据仍为 0；地点、主题、匿名人物、跨上传同故事和大批量性能覆盖不足。

## 工程修复

- 复现 `classification:t0-preflight` 直接运行时因临时编译目录无法解析仓库依赖而报 `MODULE_NOT_FOUND`。
- 临时构建现在只读链接仓库 `node_modules`；回归测试显式清空 `NODE_PATH`，避免依赖测试进程的偶然环境。
- 提交：`2c5b6c6 fix: make T0 preflight CLI resolve dependencies`。

## 验证

- 数据集 `SHA256SUMS`：198/198 通过；包外未登记文件 0。
- 独立结构与来源复算：PASS。
- `npm run test:classification`：168/168 通过。首次沙箱内运行因禁止监听 `127.0.0.1` 出现 28 个 `EPERM`，在允许本地 loopback 的测试环境重跑后全部通过；这不是代码失败。
- 对 v3 直接运行真实数据 preflight：CLI 已正常执行并按设计拒绝不兼容 schema，证明当前确实缺少 synthetic adapter。
- `git diff --check`：通过。

## 结论

数据包可作为合成工程夹具继续使用，但不满足完整产品测试要求。不得把它描述为真实数据、真实准确率、跨家庭泛化或产品收益证据。

详细审计见 [SGX 合成多模态 v3 独立可用性审计](../algorithms/CLASSIFICATION_SYNTHETIC_V3_INDEPENDENT_AUDIT.md)。

## 下一任务

1. 对 v3 新 group/truth 做独立复核并冻结 acceptance；
2. 实现 synthetic v3 到 ingestion / Stage A eval 的可执行 adapter；
3. 用 deterministic/Mock 跑通 40 组全链并生成固定分母报告；
4. 固定真实 Provider 的 exploration 子集、digest、预算和停止条件后，再申请调用授权；
5. 真实 T0/T1 仍需另行准备 30–50 组已授权真实内容组。

## 真实模型与公开数据路线补充

### 已确认事实

- “真实模型 + 合成场景”“真实摄影 + 公开许可”和“真实家庭产品数据”是三个不同证据层级。
- 现有 40 组合成 v3 可以在真值、adapter 和 Mock dry run 完成后进入真实 Qwen/GLM T0-S，不必等待公开数据集。
- 公开许可真实摄影可以补足真实老照片、手机噪声、模糊、多人和场景 domain shift，但不能提供可信亲属关系、真实用户原文、真实 final ASR、撤权和长期人物参考。
- 完整 T1 仍需本人或家庭授权的真实内容；当前真实组分母保持 0。
- FIW 官方条款限定非商业研究/教育且禁止再分发，不作为 SGX 产品测试集来源。

### 决策与产物

- 冻结三轨路线：T0-S 真实模型合成探索、T0-P 公开许可真实摄影补充、T0-R/T1 授权家庭数据。
- 新增 [真实模型 T0/T1 启动与公开数据集调研任务书](../algorithms/CLASSIFICATION_T0_T1_REAL_MODEL_DATASET_RESEARCH_BRIEF.md)，定义来源准入、许可/隐私淘汰规则、30 组公开照片候选覆盖、调研表和阶段 Gate。

### 下一步

1. 算法侧先修 v3 真值和 adapter，并完成 40 组 Mock dry run；
2. 数据调研侧比较至少 5 个官方来源，形成至少 2 个 ACCEPT 来源和 30 组/60–100 张候选清单；
3. 两条路线分别冻结后再申请准确的真实模型批次授权；
4. 另行招募或由本人/家庭提供 10–15 组授权 smoke，随后扩展到 30–50 组正式 T1 分母。

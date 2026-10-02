# SGX 云端混合分类 T0/T1 执行计划

> 日期：2026-10-02  
> 对应 Spec：`sgx-classification-cloud-hybrid.1.0.0`  
> 当前分支：`codex/classification-contract-v1`  
> 总体状态：执行中；SSH、隔离目录、源码 staging 和无模型契约测试已完成，当前阻塞转为模型制品冻结、激活 release 与常驻 Worker

## 完成标准

本计划完成时，应当得到一套能交给全栈工程师进入 T2 的可回退算法包，而不是只得到若干模型输出：

- 远端独立目录和冻结环境可重建、可切换、可回滚；
- OCR、image/text embedding、Top-K、VLM 和证据规则串成同一主链；
- 20 个产品提交的固定矩阵完成 exploration 与独立 validation；
- 本地真实页面完成 T1 人工验收；
- 控制平面接口、版本、错误码、资源基准、测试结果和限制齐全；
- 原失败、费用和 not-run 保留；没有把合成结果称为真实准确率。

## Phase 0：冻结当前算法基线

1. 审查当前工作树的 evidence-rule、稀疏组织、exact retrieval 和页面展示改动；
2. 排除已有的 lifecycle runtime 用户改动，不混入提交；
3. 运行 classification regression、typecheck、build、secret scan 和 diff check；
4. 形成一个只包含“移除 active 硬分数、改用证据决策”的小提交；
5. 文档明确旧 `0.25/0.55/0.80` 仅供历史回放。

Gate：干净、可定位的 commit；测试输出以当次分母记录。

## Phase 1：SSH 与 VirtAI 只读资源预检

1. 用户把专用公钥加入 VirtAI 账号；
2. 用 `BatchMode=yes` 验证密钥登录；
3. 运行 `scripts/classification-virtai-preflight.sh`；
4. 记录 CPU、RAM、GPU、CUDA、Python、Node、磁盘、挂载权限、已有模型和出站网络；
5. 不安装包、不下载模型、不创建生产目录。

Gate：生成脱敏 inventory 报告；明确哪些路径可写、是否有可用 GPU、已有模型能否复用。

## Phase 2：冻结开源模型与部署 manifest

1. OCR：RapidOCR + PP-OCRv5 mobile/server 两个候选；
2. Embedding：SigLIP2 Base 224 主候选、Chinese-CLIP ViT-B/16 影子对照；
3. 为每个候选记录 URL、license、revision、SHA-256、大小、预处理、输出维度；
4. 根据远端资源决定 CPU/GPU runtime；
5. 锁定 Python 依赖、Node lockfile 和非秘密环境变量；
6. 生成不可变 `releases/<git-sha>` 部署包与回滚脚本。

Gate：model manifest 和 dependency lock 可审查；没有未核验权重或 license。

## Phase 3：创建远端独立目录和环境

在 Phase 1、2 通过后才执行：

1. 创建 `/gemini/code/sgx-classification/releases/<git-sha>` 与 `shared/`；
2. 创建独立 Python venv，不污染系统 Python；
3. 部署 Node worker 与 localhost feature service；
4. 模型优先引用只读挂载，缺失模型才按 manifest 下载；模型快照、wheel、源码包、许可证和所有下载缓存必须直接落到 `/gemini/code/sgx-classification` 的持久目录，不能先把 `/quota` 或 `/tmp` 当作唯一副本；
5. 写入非秘密配置；密钥只从 VirtAI secret/env 注入；
6. 先启动 `/healthz`、`/readyz`、`/version`；
7. 从持久 wheelhouse 离线重建 `/quota` venv，并验证 `current` 原子切换和上一 release 回滚；容器恢复后不得重新联网获取已冻结依赖或模型。

Gate：离线启动通过；停止/重启后代码、manifest 仍在，唯一业务状态不依赖容器。

## Phase 4：冻结正式 adapter 并接入 Worker

1. 已有源码边界：OCR、image/text embedding、匿名人物候选和 fail-closed ASR；
2. 冻结每个 adapter 的模型 artifact、license、revision、hash、依赖锁和目标环境 smoke；
3. 实现 `FeatureServiceClient`：超时、取消、错误码、版本不匹配；
4. 实现 `CandidateRetriever`：先 scope filter，再精确 Top-K，多路 union；
5. 所有 adapter 输出进入现有 Stage A / organization 主链，不建立第二条平行产品链；
6. 首版 Worker 控制面仍只租赁 `image/user_text/final_asr`；原始音频先经过独立 ASR 前置任务，若同一 lease 要携带 audio/face feature，必须升级协议。

Gate：Fake/fixture 聚焦测试、全量 classification regression、typecheck、build、secret scan 通过。

## Phase 5：零付费组件基准

1. 修正并冻结 truth v2.1，只要求输入可见证据；
2. OCR 运行 12 图固定子集；
3. SigLIP2 与 Chinese-CLIP 运行同一 30-query/62-gallery 影子对照；
4. 在 5,000 条向量模拟规模记录 Top-K p50/p95；
5. 首个达到 Spec Gate 且资源更轻的候选获胜；停止继续堆模型；
6. 输出失败切片和资源报告。

Gate：OCR、embedding Gate 通过；模型选择和未选理由记录完整。

## Phase 6：真实模型 exploration

冻结参数：

- 模型：`qwen3.7-flash-2026-07-15`；
- 12 个提交、31 次真实 Provider 调用和 4 个确定性产品评估；
- exploration 真实调用可拆为 20 + 11；4 个确定性评估独立记账，不占真实调用额度；
- 人物候选只在授权且具备 reference policy 的场景开启；姓名和亲属关系不自动确认；
- 自动重试 0；
- 核心计划为 51 次真实 Provider 调用和 4 个确定性产品评估，共 55 个评估单元；扩展诊断必须单独预登记，全部真实请求总硬上限 150 次 / ¥25；
- 单例错误继续其他独立案例，授权/预算/model/scope 错误停止全批。

允许修复真正的共因：Prompt、adapter、Guard、绑定或组织规则。每次修复提升版本并保存旧 run。

Gate：错误已按抽取、OCR、召回、关系、聚类、摘要、Guard 或产品策略归因；没有针对 validation 调参。

## Phase 7：冻结版本并执行 T1 Validation

1. 冻结 Git SHA、Prompt、Guard、taxonomy、adapter、OCR、embedding、truth 和数据 digest；
2. 开启 8 个未用于调参的提交；
3. 执行固定 20 次真实请求；
4. validation 输出打开后禁止原地改 truth 或规则；
5. 按 Spec 第 10 节分别计算结构、关系、风险、标题摘要、成本和时延 Gate。

Gate：通过则进入产品联调；失败则形成下一版本，不覆盖本次结论。

## Phase 8：云端生命周期、重启和并发

1. 运行现有 32 lifecycle fixtures；
2. 运行 8 个服务级序列；
3. 20 个并发提交，VLM 并发 2–3；
4. 在 OCR、embedding、VLM 三个阶段分别中止 worker 并验证恢复；
5. 验证撤权、删除、晚到、幂等、CAS 和双家庭隔离；
6. 记录 CPU/GPU/RAM、queue wait、p95、费用和临时文件清理。

Gate：无重复计费、无 stuck Job、无跨家庭候选、无晚到结果覆盖。

## Phase 9：T1 本地产品页面验收

在 `/classification-lab/real` 人工跑通：

- 单图；
- 多图 + 批次说明；
- 显式单图/多图绑定；
- family transfer；
- 文字/ASR 冲突；
- 取消或撤权；
- OCR/embedding/VLM 降级；
- 标题摘要和证据追溯。

页面必须先返回后台 processing 状态，不能阻塞上传。密钥只在服务端或远端 secret 注入。

Gate：产品负责人按 10 个代表故事盲审；无 P0/P1。

## Phase 10：全栈 T2 交付

交付包包含：

- 本 Spec 和执行报告；
- OpenAPI / JSON Schema / 稳定错误码；
- deployment manifest、model manifest、环境变量表；
- release、启动、健康检查、升级和回滚命令；
- 冻结数据集、truth、运行目录和 digest；
- OCR、embedding、真实 VLM、生命周期、并发、页面报告；
- 已知限制与 T3 不能声称的内容。

全栈工程师实现产品 DB、对象存储、正式鉴权、lease queue/outbox、物理删除传播和监控告警；算法侧保留 Provider、Prompt、模型与规则替换边界。

## 当前下一动作

1. 冻结模型来源、license、revision、SHA-256 和目标环境 dependency lock；
2. 在既有隔离根目录创建不可变 release，完成真实 adapter 的离线 smoke、`/readyz`、`/version` 和回滚；
3. 完成常驻 Worker、FeatureServiceClient 与产品控制面无模型联调；
4. 通过零付费 OCR/embedding Gate 后冻结 run manifest，再执行真实模型 exploration；
5. exploration 修复收敛后冻结新版本并运行独立 validation，随后完成生命周期、并发和页面验收。

# SGX 分类归纳运行配置索引

> 2026-10-09 接入更新：完整 API `8765`，内部模型组件 `8766`，执行器内嵌；全栈使用 [直接 API](CLASSIFICATION_DIRECT_API_INTEGRATION_2026-10-09.md)。下表模型冻结参数继续沿用，旧 Worker 对外控制面和网关并发参数为历史配置。

> 面向：全栈工程师、算法工程师、部署维护人员  
> 状态：T1 内部测试配置；不包含任何密钥、Token、用户素材或 `.env.local`

## 1. 当前模型与运行位置

|能力|当前选择|冻结版本或 revision|设备|全栈是否直接调用|
|---|---|---|---|---|
|OCR|RapidOCR + PP-OCRv5 中文 mobile|RapidOCR `3.9.2` / `rapidocr-3.9.2-ppocrv5-mobile`|CPU|否，由 Worker 调 localhost Feature Service|
|图文 Embedding|`damo/multi-modal_clip-vit-base-patch16_zh`|`e6d9ca1cf467fb979d8511ed8349d29bdfd8ea1b`，512 维|`cuda:0`，FP16，batch 1|否，由 Worker 生成候选并通过产品后端持久化|
|人脸检测|OpenCV Zoo YuNet|`47534e27c9851bb1128ccc0102f1145e27f23f98`|Feature Service|否；只生成匿名人物候选|
|人脸特征|OpenCV Zoo SFace|同上，128 维|Feature Service|否；姓名和亲属关系仍需产品确认|
|ASR|SenseVoiceSmall + FunASR|模型 `7bf452403abd7353a300cd760f7adae7701c92c1` / FunASR `1.4.16`|`cuda:0`|用户从产品麦克风录音，后端创建 ASR 任务|
|困难语义与故事摘要|Qwen `qwen3.7-flash-2026-07-15`|Prompt `sgx-five-facets.16` / validation `stage-a-validation.4`（2026-10-07 定向修复）|阿里云 API|否，由服务端 Worker 调用，密钥不进入浏览器|

validation `.4` 增加轻微人物框边界漂移的裁剪、单项输出错误的独立处理与错误记录，并将正常 Top-K 限量保留在 candidateTraces 中；不把限量本身变成人工任务。OCR 引用接受 NFKC 与空白差异，仍须是可追溯原文的子串，语义改写不能通过。具有有效 usage、响应 ID 和相同模型版本的解析失败按实际用量结算；缺少这些证据时保留保守预留。`.3` 真实运行与失败记录仍保留；当前云端激活与真实复测见第 6 节。

这些选择的来源、license、模型路径和远端 smoke 证据在：

- `deploy/classification-worker/model-candidates.json`
- `deploy/classification-worker/nonsecret.env.example`
- `deploy/classification-worker/README.md`
- `services/classification-feature-service/README.md`

## 2. 输入与容量配置

|项目|T1 配置|说明|
|---|---:|---|
|图片数量|8 张/轮|多轮会话可继续追加；历史检索按家庭与老人隔离|
|单张原图|10MiB|JPEG、PNG、WebP；原图是 Evidence 权威来源|
|单轮总输入|80MiB|外网窄网关请求体为 96MiB，预留 multipart 开销|
|像素数|40MP 产品入口；80MP Feature Service 防御上限|入口先收紧，Feature Service 再防御|
|VLM 图片副本|最长边 1600px，目标不超过 900KiB|去元数据 JPEG；保留原图哈希、派生哈希、转换版本|
|文字或 final ASR|64KiB/项|用户原文和 final ASR 独立保存、独立引用|
|原始音频|50MiB，最长 10 分钟|T1 页面麦克风默认最长 2 分钟；服务端保留更宽防御上限|
|并发|窄网关 4；Worker 1；VLM 配置上限 2|5.81GiB vGPU 首版优先稳定和可观测性|
|自动重试|0|避免重复计费；失败由控制面显式创建新 attempt|

OCR、Embedding、人脸特征读取哈希验证后的原图。VLM 使用派生副本，防止大图 Base64 放大造成高延迟、请求失败和不必要的传输成本。模型副本不是新事实，也不能替代原始 Evidence。

## 3. 配置文件地址

|用途|仓库路径|
|---|---|
|非密钥部署参数|`deploy/classification-worker/nonsecret.env.example`|
|模型选择、license、revision 与证据|`deploy/classification-worker/model-candidates.json`|
|Feature Service 默认值与环境变量解析|`services/classification-feature-service/src/sgx_classification_feature_service/config.py`|
|Feature Service 接口|`services/classification-feature-service/src/sgx_classification_feature_service/app.py`|
|VLM Prompt、模型请求与输出校验|`src/lib/algorithms/classification/stage-a-provider.ts`|
|T1 每轮预算与稀疏候选配置|`src/lib/algorithms/classification/t1-lab-service.ts`|
|累计真实调用门禁|`src/lib/algorithms/classification/real-call-budget.ts`|
|外网窄网关|`scripts/classification-t1-external-gateway.mjs`|
|全栈接入契约|`docs/algorithms/CLASSIFICATION_FULLSTACK_INTEGRATION_GUIDE_V2.md`|
|云端部署和回滚|`deploy/classification-worker/README.md`|

## 4. 凭据边界

以下内容不属于交付配置，禁止发送或提交：

- 任意 `.env.local`；
- `SGX_D4_API_KEY`；
- Worker Bearer Token；
- T1 staging 外网 Token；
- SSH 私钥；
- 用户原图、音频、原文和原始 Provider 响应。

全栈工程师通过部署平台 Secret 或团队密码管理器获得各环境独立凭据。浏览器只持有产品登录态，不持有模型、Worker 或 staging Token。

## 5. 全栈工程师使用方式

当前使用 [完整直接 API](CLASSIFICATION_DIRECT_API_INTEGRATION_2026-10-09.md)：
产品前端 → 产品后端（登录/权限/存储）→ 算法 HTTPS → 云端8765 API → 内部8766组件和Qwen。
全栈只实现提交、轮询、结果入库及产品页面，不实现外部Worker lease/heartbeat。
服务Token仅产品后端持有，模型凭据仅算法API持有；两者不进入浏览器。
公网HTTPS映射由全栈完成，当前只有同机调用实测，不能把SSH/quick tunnel当稳定入口。

## 6. 2026-10-09 当前激活版本

- current：`87631dadb8cf9ece27eec96fe742033a4d3c8cef`；previous：`bcecd6889a67c7a7eb4311cb24c2b247b1a7d56a`。两者均保留，核心算法继续沿用82cab23，模型/Prompt未更换。
- 完整API `127.0.0.1:8765`，组件`127.0.0.1:8766`；独立管理程序`current/classification-api/bin/supervise.py`，不用Notebook Cell或开发机隧道。
- 最新启动工具：`shared/tools/direct-api-operator-6d2c82b/start.sh`，识别僵尸PID；它独立于immutable release。日志保存持久`shared/logs`，不覆盖旧失败。
- 现场health/version200，组件ready200，五组件loaded；完整ready503准确反映Qwen凭据未配置。新增入口真实ASR成功约2.675秒，重启/跨release复读SHA一致。
- 权威预算已迁移到持久`shared/api-budget`，本机旧账本备份并halted，累计193/200次、¥23.243669/¥50；到期2026-10-10零点+08:00。没有新增Qwen请求。
- 受控API/组件退出恢复已验证，组件冷预热约125秒。平台实例回收、超过1小时稳定性和10人性能尚未证明。

证据见[当日执行记录](../execution/2026-10-09-execution-log.md)；新API/OpenAPI、完整处理流程和产品联调步骤见直接API说明。

## 7. 2026-10-07 历史算法基线

- `current`：`82cab23cd81a2f0b06a3c00606025153a2816468`；`previous`：`09b5f04b0c19a1a528b079da19c20072f201cdb1`。369 项发布文件哈希通过，manifest digest：`07b950130fe9f9882d8e138b4c74ff8b22b2feb6691338a54b9a0157eee3b1be`。
- 模型与代码 manifest 各有独立摘要；不能把模型候选制品摘要填成代码 release 摘要。示例环境变量必须由发布组装脚本替换成目标 release 的实际身份，不能直接启用仓库示例。
- 召回保持 `K=1`；组织关系总上限独立为 `min(128, max(1, 3 * (activeContentCount - 1)))`，不再误用 K 拒绝有效多图关系。跨轮 model reference 与历史检索使用相同的 model ID/revision 校验。
- 云端 `/version`、`/readyz` 已核验 OCR、image/text embedding、face、ASR 均 loaded，Face/ASR enabled=true；同 session 两轮真实图文成功，结果可持久化复读。跨轮只返回搜索/相册建议候选，没有自动合并故事。
- 原六图与跨轮失败均保留；新版六图未重新付费重跑。最终控制面账本 193/200 requests、¥23.243669/¥50，余 7 次、¥26.756331。
- Notebook idle 回收与正式 HTTPS 产品后端仍待 T2 解决。当前 ready 只证明此刻服务可用，不等于常驻可靠性或真实用户 p95。

详细证据见 [本轮真实复测报告](CLASSIFICATION_T1_TARGETED_RETEST_2026-10-07.md)；全栈下一步按 [当前执行计划](../superpowers/plans/2026-10-07-classification-targeted-handoff-execution-plan.md) 的 T2 分工接入。

# SGX 分类归纳运行配置索引

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

validation `.4` 增加轻微人物框边界漂移的裁剪、单项输出错误的独立处理与错误记录，并将正常 Top-K 限量保留在 candidateTraces 中；不把限量本身变成人工任务。OCR 引用接受 NFKC 与空白差异，仍须是可追溯原文的子串，语义改写不能通过。具有有效 usage、响应 ID 和相同模型版本的解析失败按实际用量结算；缺少这些证据时保留保守预留。`.3` 真实运行与失败记录仍保留；新版本是否已经远端激活和复测见当日执行记录。

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

短期 T1：全栈后端使用 HTTPS staging URL 和 Bearer Token 调窄网关，验证提交、轮询、ASR 和显式重试。Token 不进入浏览器。

正式 T2：产品前端调用业务后端；业务后端保存原始素材与 Evidence/Job，VirtAI Worker 通过出站 HTTPS 主动 lease 任务并回传结果。全栈工程师不需要把 SSH 暴露给用户，也不直接开放 OCR、Embedding 或 GPU 端口。

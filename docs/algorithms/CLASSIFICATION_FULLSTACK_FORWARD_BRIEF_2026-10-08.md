# SGX 自动分类与归纳：转交全栈工程师的接入说明

> **接入方案已于 2026-10-09 更新**：[直接算法 API 说明](CLASSIFICATION_DIRECT_API_INTEGRATION_2026-10-09.md)。下文 Worker pull 为历史方案，不再要求全栈实现；本文件保留恢复记录。

> 日期：2026-10-08。此文件是本次交接入口，详细字段以所链接的当前契约与实现为准。
> 交付状态：可用于产品接入的算法基线；完整公网产品任务闭环尚待接入。
> 仓库：[GOATWEN6/SGX-classification](https://github.com/GOATWEN6/SGX-classification/tree/codex/classification-t1-external-20261006)
> 分支：`codex/classification-t1-external-20261006`。请使用该分支，不默认使用 `main`。

## 1. 本次反馈已经怎样处理

“云端没有算法服务，只有报错 Worker”的反馈已复现并处理。2026-10-08 现场核验：

- Feature Service 被 Notebook 平台空闲机制回收，现已使用既有离线环境恢复并预热。
  OCR、图文 embedding、匿名人脸特征、ASR 均成功返回，`/readyz=200 ready`。
- Worker 使用的旧开发控制面 `127.0.0.1:3139` 已无法正常返回 HTTP，空转 Worker
  已停止，等待接正式产品后端。旧失败、日志、账本和发布保留。
- 启动文档路径已修正：仓库源码是 `deploy/classification-worker`，云端 release
  实际是 `current/worker`。新增独立的统一启动和只读诊断工具，已部署并现场验证。

这是现场恢复证据，后续使用前仍应运行健康检查。平台空闲回收尚未解决，不能仅凭
一次 ready 就放行长期稳定使用。完整原因与恢复记录见 [服务恢复说明](CLASSIFICATION_SERVICE_RECOVERY_2026-10-08.md)。

## 2. 调用方式与准确端口

当前采用 Worker 主动拉任务：

```text
产品前端 → 产品后端 HTTPS → 数据库/对象存储/Job
                                   ↑
                     云端 Worker 主动领取并回传结果
                                   ↓
                    127.0.0.1:8765 本地模型组件
                    + Qwen 语义提取/有限关系判断/摘要
```

|入口|用途|接入结论|
|---|---|---|
|云端 `127.0.0.1:8765`|OCR、embedding、匿名人脸特征、ASR|Worker 同机调用；输入是经哈希校验的本地文件路径，不是公网上传或完整分类 API|
|Worker|特征提取、分类、组织、回传|没有监听端口，主动访问产品控制面|
|SSH `30022`|部署和排查|不是产品 HTTP 端口|
|旧控制面 `3139`|开发隧道残留|已不可用，不能继续作为接入地址|
|产品 staging HTTPS 地址|上传、任务状态、结果与智能相册|由全栈部署；算法侧随后配置 Worker 连接|

**目前没有可直接从外网调用完整自动分类与归纳的稳定算法 URL。**
请先对齐 Worker 拉任务这一接入方式。如果工程师期望“产品后端请求一个独立算法
HTTPS API”，请明确反馈该要求，双方先决定接口形态；现有 Worker 不等于已实现这种 API。

## 3. 各方负责什么

|负责方|本轮任务|
|---|---|
|全栈|复用现有产品后端和存储；实现鉴权、Evidence/Job、任务租约及结果入库；部署 staging HTTPS 后端；接上传、麦克风与相册页面|
|算法侧|维护模型组件、分类核心、Prompt、校验与组织；配置云端 Worker；核验接口兼容并参与真实任务联调|
|平台/运维|落实常驻实例或平台服务模式、进程监督、健康重启与日志告警；处理 Notebook idle 回收|
|Owner|协调责任人和必要的平台配置；不需要自行编写产品后端|

全栈无需重新训练模型或重写分类算法。模型服务和 Worker 凭据只在服务端通过
团队 Secret 渠道配置，不转发 `.env.local`、API Key、Token 或 SSH 私钥。

## 4. 先读哪些文件，复用哪些代码

|顺序|文件|重点|
|---|---|---|
|1|[服务恢复与端口说明](CLASSIFICATION_SERVICE_RECOVERY_2026-10-08.md)|真实恢复状态、云端目录、启动/诊断、尚缺条件|
|2|[全栈接入手册 v2](CLASSIFICATION_FULLSTACK_INTEGRATION_GUIDE_V2.md)|§4 产品接口、§5 Worker 协议、存储/权限/幂等/取消语义|
|3|[全栈接手说明](CLASSIFICATION_FULLSTACK_TAKEOVER_GUIDE_2026-10-07.md)|§5 分类、历史查询和独立 ASR 路由；§7–8 接入顺序和验收|
|按需|[运行配置索引](CLASSIFICATION_RUNTIME_CONFIGURATION.md)|模型、revision、容量与非密钥配置|
|按需|[完整算法指南](CLASSIFICATION_ALGORITHM_COMPLETE_GUIDE.md)|原理、Prompt、规则、数据流；早期状态以本次接手/运行配置为准|

|工程材料|仓库位置|
|---|---|
|输入契约|[classification-ingestion-v2.schema.json](../../contracts/classification-ingestion-v2.schema.json)|
|分类任务控制面契约|[classification-worker-control-plane.schema.json](../../contracts/classification-worker-control-plane.schema.json)|
|历史候选查询契约|[classification-historical-retrieval.schema.json](../../contracts/classification-historical-retrieval.schema.json)|
|Worker、HTTP 客户端、部署和预热工具|[deploy/classification-worker](../../deploy/classification-worker/README.md)|
|OCR/embedding/face/ASR 服务|[services/classification-feature-service](../../services/classification-feature-service/README.md)|
|分类核心与适配器|`src/lib/algorithms/classification/`|
|控制面路由参考|`src/app/internal/v1/classification/`|
|T1 上传/录音/结果参考|`src/app/classification-lab/t1/` 与 `src/app/api/classification-lab/t1/`|

ASR 当前独立协议是 `classification-asr-worker.1`，尚无独立语言无关 JSON Schema。
依据 `src/lib/algorithms/classification/t1-asr-prejob.ts`、
`deploy/classification-worker/runtime/asr-worker-runtime.mjs` 和接手说明 §5.3
对齐实际 OpenAPI，不能把分类 Worker Schema 当成已经覆盖 ASR。

## 5. 最短接入顺序与首条验收

1. 全栈先提供 staging HTTPS 基地址、后端技术栈和接入责任人，确认现有存储可提供
   短时签名读写 URL；说明愿意沿用 Worker 拉任务还是需要另议独立算法 API。
2. 沿用当前协议实现分类 lease、execution-context、heartbeat、complete、fail、
   cancel-ack、historical-query；语音再接独立 ASR lease/heartbeat/complete/fail。
   具体字段、路径和状态码见接入手册及接手说明，不凭此摘要自行简化权限/版本核验。
3. 双方核对契约与授权配置，算法侧设置控制面地址、注入所需凭据并启动 Worker。
4. 先完成一个已授权图文任务：产品上传 → Job 被领取 → 真实模型计算 → 结果入库
   → 页面展示 → 刷新可复读。保留 jobId、版本、耗时和失败记录。
5. 首条通过后补麦克风 ASR、同家庭/同授权多轮追加、取消/撤回、服务恢复。
   复用历史算法证据，集中处理新产品接入问题，不重复全部旧评测。

这轮不承诺跨轮自动合并故事或稳定跨年代人物身份；当前历史召回为关联候选。
人物姓名/亲属关系、敏感事实和长期 Memory 仍保留独立确认。

## 6. 云端运维入口

授权运维人员在云端执行：

```bash
cd /gemini/code/sgx-classification/shared/tools/service-operator-20261008-r1/worker
bash bin/status-stack.sh
```

报告缺口时返回非零，先处理报告中的原因。冷启动的完整启动/预热命令见
[部署 README](../../deploy/classification-worker/README.md)，正式后端配置前不要加 `--worker`。
新工具与模型均在 SGX 隔离目录；不把权重或缓存下载到非持久盘，不原地修改旧冻结 release。

当前算法 release：`82cab23cd81a2f0b06a3c00606025153a2816468`。
当前语义模型：`qwen3.7-flash-2026-07-15`，Prompt `sgx-five-facets.16`，
校验 `stage-a-validation.4`。产品入口参考容量：8 图/轮、10 MiB/图、80 MiB/轮。
真实测试前核对账本；累计授权仍为 200 次/¥50，最新结算记录余 7 次，自动重试为 0。

## 7. 请工程师先回复

```text
接入责任人：
产品后端技术栈/部署环境：
staging HTTPS 基地址（尚未部署请说明）：
存储是否支持短时签名读写 URL：
接入方式：沿用 Worker 拉任务 / 需要讨论独立算法 API
预计完成首条图文任务的时间或当前阻塞：
```

普通回复只提供非密钥信息；凭据另走团队 Secret 渠道。地址和协议对齐后，由算法侧
配置 Worker 并共同验证第一条真实产品任务。

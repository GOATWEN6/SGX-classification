# SGX T1 定向真实复测报告（2026-10-07）

## 目的与版本

只补已确认缺陷和缺少证据的路径，复用已有 ASR、混合模型链和持久化成功证据。使用同一 session/scope/authorization，人物候选开启；身份、关系、敏感事实和长期 Memory 独立确认。算法基线 `82cab23cd81a2f0b06a3c00606025153a2816468`，Qwen `qwen3.7-flash-2026-07-15`，Prompt `sgx-five-facets.16`，validation `stage-a-validation.4`。

## 真实结果

|任务|状态|请求与费用|结果|
|---|---|---|---|
|六图 `lab_run_14198d00c3074d878cc9acdc`|`failed_terminal`|10 requests / ¥0.089603|模型返回后组织器误用召回限量，`RETRIEVAL_LIMIT_EXCEEDED`；保留失败|
|第一轮 `lab_run_b9e14fcfc791db874d9b2958`|`succeeded`|1 request / ¥0.0093828|1 个故事，图片+用户文字，10 条 observations，无 review|
|第二轮原任务 `lab_run_7c86f05f22a7625f5256e3ef`|`failed_terminal`|1 request，3343 input / 1101 output，账本按实际 usage 结算|`PROVIDER_INVALID_OUTPUT`；模型身份/stop 有效，跨轮适配器误拒 namespaced model ID；保留失败|
|修复后 `lab_run_ca1dba54a2738b981080dd98`|`succeeded`|1 request / ¥0.0093012|attempt 2 引用原失败 Job；1 个故事，9 条 observations，无 review；4 条历史候选|

第一轮 `metrics.latencyMs` 为 18.772 秒（3343 input / 1119 output），修复后第二轮为 16.839 秒（3343 input / 1102 output）；不是完整产品端到端 p95。历史候选为 1 条图文和 3 条匿名人脸候选，全部指向第一轮同一张图片，不能算作 4 张历史图片。

## 修复与核验

1. `ec3ba7c`：轻微人物框边界漂移裁剪、OCR 的 NFKC/空白归一、有效 usage 的失败结算、单图独立失败；正常 Top-K 裁剪不制造人工复核。
2. `09b5f04`：召回 K 与组织关系数量上限分离；模型身份/usage 检查提前，格式错误不能绕过立即停止条件。本地和远端聚焦回归 106/106。
3. `82cab23`：跨轮 model ID/revision 与历史检索统一校验，接受 `damo/...` 和当前 OpenCV Zoo 模型引用。本地和远端聚焦回归 27/27、typecheck、secret scan、diff check 通过。

云端 current 为 `82cab23`，previous 为 `09b5f04`；369 项发布文件哈希核验通过，manifest digest 为 `07b950130fe9f9882d8e138b4c74ff8b22b2feb6691338a54b9a0157eee3b1be`。OCR、image/text embedding、face、ASR 均 loaded。两轮结果已从持久文件复读，标题、摘要、标签、历史引用和 result digest 均存在：

- 第一轮：`sha256:10fb6f7c28a2049e1b8db635febe466f2c37889500ac97cbf0db183d69343cea`
- 第二轮复验：`sha256:3ab25853376df63bb8d54ccb08d7b05b0004fb3d564c5df328a5900ea7c1c68e`

## 交付判断与剩余工作

当前代码、契约、Worker、Feature Service、模型配置和 T1 证据可作为全栈接入基线。新版六图没有重新付费重跑，不能写成“新版六图已真实通过”。跨轮只返回 `candidate_only / possibly_related` 搜索与相册建议，没有跨轮 VLM 同事件验证或自动合并故事；人物候选不是确认身份。

正式产品接入还需产品 HTTPS、数据库/对象存储事务、租约与撤回、固定生命周期和进程监督，以及图文、ASR、历史追加、取消/撤回、恢复五类 T2 联调。当前 ready 不能证明 Notebook idle 回收已消除；没有已证明稳定的公网入口。真实模型功能链成功也不等于现实家庭准确率或产品效果。

最终控制面账本为 **193/200 requests、¥23.243669/¥50**，余 7 次、¥26.756331。0 自动重试，原失败、旧授权、旧账本和 release 保留；不为成功场景重复付费。

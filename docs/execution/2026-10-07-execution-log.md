# 2026-10-07 SGX 分类归纳执行记录

## 用户要求与执行边界

接续算法开发、真实测试和全栈交付；复用已有证据，避免重复测试。交付到 `GOATWEN6/SGX-classification`，无需 ZIP。持久根 `/gemini/code/sgx-classification`；人物候选开启，身份、敏感事实、长期 Memory 仍独立确认。累计真实调用上限 200 次 / ¥50，0 自动重试。

## 最新状态

- 当前云端 release 为 `82cab23cd81a2f0b06a3c00606025153a2816468`；`previous` 保留 `09b5f04b0c19a1a528b079da19c20072f201cdb1`。369 项发布文件哈希通过，manifest digest 为 `07b950130fe9f9882d8e138b4c74ff8b22b2feb6691338a54b9a0157eee3b1be`。
- 同 session/scope/authorization 的两轮真实图文测试成功，结果已持久化复读；第二轮返回第一轮的图文及匿名人脸关联候选。跨轮关联仍为 `candidate_only / possibly_related`，没有跨轮同事件验证和自动合并故事。
- 最终控制面账本为 **193/200 次、¥23.243669/¥50**，剩余 7 次、¥26.756331。真实测试已停止，不重复已成功场景。
- 当前为 `internal_release_candidate`，可交付全栈接入。正式产品 HTTPS、业务数据库/对象存储、常驻生命周期与 T2 联调尚未完成；不能称最多 10 人已可稳定使用。

## 接续开始时核验的事实

- 本地 HEAD `c9877afc2f4af28966679bef12d18437f5e21028`，分支 `codex/classification-contract-v1`，开始时工作区干净。
- 本机 terminal/SSH/Node/npm 可用；模型 Keychain 条目存在，仅检查状态，不输出 secret。
- 旧专用 Ed25519 认证失败；用户此前提供的平台 RSA 指纹与历史声明一致。仅将其权限由 0644 收紧为 0600，再使用单次 `PubkeyAcceptedAlgorithms=+ssh-rsa` 恢复连接，未改全局 SSH 配置。
- 远端 `current` 指向 c9877af，持久目录、既有离线环境和模型仍在。Worker PID 22172 存在；Feature Service PID 文件残留 22160，8765 无监听，日志记录 `ORION_TASK_IDLE_TIME=3600` 后退出。进程存在不等于健康，改为 py 不能自行消除平台回收。
- 读取最近六图的远端审计元数据：5 条、15514 字节，SHA-256 `c86a21e781db5ebf18ee175c3de4c963cc0dadb65b448481164874652225fbbb`，与交接一致。5 次均 finish_reason=stop；第 5 张有结构化输出，第 6 张没有请求。
- `CANDIDATE_TRUNCATED` 的代码来源是候选检索限量；不是 provider 输出截断。第 5 张具体问题为 `observations.0.people.1.box.x:too_small`，坐标 x=-0.01；严格校验拒绝整图后旧版停止了第 6 张。
- 在原服务器回放全部 5 条历史响应，`.4` 均通过结构解析；原第 5 条仅有轻微框边界漂移。本地未复制原始私密响应，只返回脱敏计数和哈希，未新增 API 请求。
- 三项旧 OCR support 的差异仅是 NFKC/空白；第五张另一个地点引用在机械归一后仍不匹配，继续丢弃。没有按目标标签放宽语义依据。
- 旧六图审计实际 usage 合计输入 18,344 / 输出 3,217，按冻结单价为 ¥0.0374544；旧账本记录 ¥0.098434 含解析失败的保守预留。差额约 ¥0.0609792 已记录，旧账本未覆盖，新授权沿用较高的累计余额以免扩大授权。
- 旧单轮多图、ASR→分类链和持久化有成功证据，直接复用。历史关联缺口源于每轮新建授权版本；所有旧 result-bearing Job 启动时同授权可用历史为 0。只补同 session/scope/auth 两轮验证，不改权限过滤。
- 账本已结算：180 次 / ¥23.126084，余 20 次 / ¥26.873916；本轮截至此记录未新增真实模型调用。

## 接续时采用的计划

采用 [定向修复与全栈交付计划](../superpowers/plans/2026-10-07-classification-targeted-handoff-execution-plan.md)。优先离线复现第 5 张和 OCR 引用问题，聚焦修复后恢复服务并定向复测。已有 2026-10-04 图文真实混合链与文件持久化记录直接复用，不要求相同场景全部重跑。

以上是工程与功能链证据，不构成真实家庭准确率或产品用户效果结论。

## 本轮修复与验证

- `stage-a-validation.4`：人物框只裁剪不超过 0.01 的边界漂移；像素框、大越界、异常键继续拒绝。OCR 仅允许 Unicode/空白漂移；有效 usage 在解析失败时也结算。独立图片错误继续后续图片，不自动重试；服务、权限和预算错误仍停止。
- Top-K 限量保留审计，不再生成复核项；真正阶段错误包含 stage、photoId、code，保留 pending 与有效图片。
- 修复前段完整回归 547/547 通过；追加 OCR 与失败计费后聚焦回归 84/84 通过。TypeScript typecheck、secret scan 和 diff check 通过。独立只读审查没有发现新增阻断问题。
- 云端原 release Feature Service 已恢复；预热后 healthz=ok、readyz=ready，OCR、image/text embedding、face、ASR 均 loaded。该事实只证明当前可用，不证明平台 idle 生命周期已消除。

## ec3ba7c 真实复测与第二批修复

- 已建立并激活不可变 release `ec3ba7c9d670917e438a4b76a6f15280e614f338`，345 个文件哈希及远端 84/84 聚焦回归通过；previous 保留 c9877af。配置备份保存到持久 SGX 目录。
- 六图真实任务 `lab_run_14198d00c3074d878cc9acdc` 实际发生 10 次请求，费用 ¥0.089603；最终 failed_terminal。远端诊断为 `RETRIEVAL_LIMIT_EXCEEDED`，发生在模型返回后的组织适配层，不是未接触真实模型。
- 根因：Top-K=1 限制每张图的召回与付费比较，但组织器错误地用同一值限制节点的全部入边/出边。09b5f04 将组织结构上限与召回 K 分开；K、授权和付费预算不变。第二项修复将模型身份/usage 检查提前，防止可恢复格式错误绕过立即停止条件。
- 第二批修复已完成 106/106 聚焦回归、typecheck、secret scan 和 diff check。四图共享事件用例实际执行关系模拟；没有重跑全部历史测试。
- 本次 SSH 只读核验：current=ec3ba7c，Feature Service ready，OCR、image/text embedding、face、ASR 均 loaded；远端能回查开发控制面。Worker 无新增 401。
- 当前控制面账本实测为 190/200 次、¥23.215687/¥50，余 10 次；旧账本未覆盖。两条旧 pending 创建于 2026-10-03/05，deadline 已过且 profile 为 `.2/.3`，不作为本轮任务执行。
- 下一项仅补同 session/scope/authorization 两轮真实验证，随后更新文档并推送。Cloudflare quick tunnel 曾出现 530，不能作为正式稳定地址；产品 HTTPS 后端与常驻推理实例仍是 T2 依赖。

## 同授权两轮真实复测与最终修复

- 第一轮 `lab_run_b9e14fcfc791db874d9b2958` 为 `succeeded`：1 次 Qwen，3343 input / 1119 output tokens，¥0.0093828；1 个故事，包含图片与用户文字、10 条 observations，无 review。`metrics.latencyMs` 为 18.772 秒，不能解释为完整产品端到端延迟。
- 第二轮原任务 `lab_run_7c86f05f22a7625f5256e3ef` 保留为 `failed_terminal / PROVIDER_INVALID_OUTPUT`。实际消耗 1 次请求，模型身份、`finish_reason=stop` 和 usage 有效。用真实历史特征离线复现 `model.id: invalid_string`：跨轮适配器误用业务 ID 校验，拒绝了 `damo/...` 模型引用。
- `82cab23` 将跨轮 model ID/revision 校验统一为与历史检索相同的 modelRef，补充当前 Chinese-CLIP/OpenCV Zoo 引用回归。本地和远端 27/27 聚焦回归、typecheck、secret scan、diff check 通过；旧失败与 release 保留。
- 修复后独立复验 `lab_run_ca1dba54a2738b981080dd98`（attempt 2，引用原失败 Job）成功：1 次 Qwen，3343 input / 1102 output tokens，¥0.0093012，`metrics.latencyMs` 为 16.839 秒；1 个故事、9 条 observations、无 review。4 条历史候选包括 1 条图文与 3 条匿名人脸候选，均指向第一轮图片，不能解释为 4 张不同历史图。
- 两轮结果已从持久文件复读，标题、摘要、标签、历史引用及 result digest 仍存在。ASR 本轮预热成功，麦克风→ASR→分类链复用此前真实成功证据，未重新录音测试。
- 云端 `/version` 与 `/readyz` 再次核验：`current=82cab23`；OCR、image/text embedding、face embedding、ASR 均 loaded，Face/ASR enabled=true；Worker 复验成功且无新增 401。Notebook idle 生命周期仍未解决。
- 新版六图修复有 106/106 定向回归证据，但未再次付费重跑六图。原六图失败 `lab_run_14198d00c3074d878cc9acdc`（10 次 / ¥0.089603）继续保留，不改写为成功。

## 下一阶段

1. 更新当前交付文档、配置索引和真实复测报告；只做链接、密钥和 diff 核验，再 fast-forward 上传到 `codex/classification-t1-external-20261006`，不覆盖其他分支。
2. 全栈同步实现正式产品 HTTPS API、对象存储引用、业务事务和 Worker lease/heartbeat/result；平台落实固定生命周期实例与 supervisor。用户和全栈调用产品 API，无需向用户分发 SSH。
3. 以图文上传、麦克风 ASR、同 session 追加检索、取消/撤回、服务恢复五类最小 T2 联调验证产品边界；不重新跑完整历史矩阵。跨轮自动归并需另补候选同事件验证与可撤回合并，不能用召回相似度直接形成事实。

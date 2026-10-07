# 2026-10-07 SGX 分类归纳执行记录

## 用户要求与执行边界

接续算法开发、真实测试和全栈交付；复用已有证据，避免重复测试。交付到 `GOATWEN6/SGX-classification`，无需 ZIP。持久根 `/gemini/code/sgx-classification`；人物候选开启，身份、敏感事实、长期 Memory 仍独立确认。累计真实调用上限 200 次 / ¥50，0 自动重试。

## 已核验事实

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

## 计划与下一步

采用 [定向修复与全栈交付计划](../superpowers/plans/2026-10-07-classification-targeted-handoff-execution-plan.md)。优先离线复现第 5 张和 OCR 引用问题，聚焦修复后恢复服务并定向复测。已有 2026-10-04 图文真实混合链与文件持久化记录直接复用，不要求相同场景全部重跑。

以上是工程与功能链证据，不构成真实家庭准确率或产品用户效果结论。

## 本轮修复与验证

- `stage-a-validation.4`：人物框只裁剪不超过 0.01 的边界漂移；像素框、大越界、异常键继续拒绝。OCR 仅允许 Unicode/空白漂移；有效 usage 在解析失败时也结算。独立图片错误继续后续图片，不自动重试；服务、权限和预算错误仍停止。
- Top-K 限量保留审计，不再生成复核项；真正阶段错误包含 stage、photoId、code，保留 pending 与有效图片。
- 修复前段完整回归 547/547 通过；追加 OCR 与失败计费后聚焦回归 84/84 通过。TypeScript typecheck、secret scan 和 diff check 通过。独立只读审查没有发现新增阻断问题。
- 云端原 release Feature Service 已恢复；预热后 healthz=ok、readyz=ready，OCR、image/text embedding、face、ASR 均 loaded。该事实只证明当前可用，不证明平台 idle 生命周期已消除。

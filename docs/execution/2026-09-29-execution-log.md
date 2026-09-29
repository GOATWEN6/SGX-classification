# 2026-09-29 SGX 执行记录

## 本日目标

在用户批准的 6 次、¥1 上限内，用 `qwen3.7-flash-2026-07-15` 对 synthetic-v3.1 r5 的 6 个 exploration 场景做真实模型 T0 工程探索；保留原始失败证据，修复明确的本地 Guard 缺口，并判断下一步产品联调条件。

## 用户决策

- 批准模型：`qwen3.7-flash-2026-07-15`。
- 批准上限：6 次请求、¥1、0 自动重试。
- 不做人脸匹配。
- 密钥继续从本地 Keychain 读取，不在聊天、Git、报告或结果目录中保存明文。

## 已确认事实

- 6/6 次真实模型请求已完成，图片发送 6 次，输入 19,133 Token，输出 4,783 Token，按清单费率记账 ¥0.045918。
- 原始运行状态：2 succeeded、2 needs_review、2 failed；失败分别是 `INVALID_TIME` 和 `UNSUPPORTED_TIME_PRECISION`。
- 两个失败均来自本地时间规范化，而不是 HTTP、认证、模型版本、预算或 JSON Schema 故障。
- g015 的图片内提示词事件被 sanitizer 删除，安全场景保留，证明该局部隔离路径按设计工作。
- g007、g011、g023、g025 仍存在模型语义与 truth 口径差异，不能用 6 例生成正式准确率。

## 工程修复

1. `689b64a fix(classification): normalize partial month to year`
   - 将有来源支持的 `YYYY-MM + precision=year` 保守降级为四位年份。
   - Guard 版本提升到 `.11`，使旧缓存失效。
2. `a27faf2 fix(classification): ground colloquial short years`
   - 支持相册口语两位年份：`00–29 → 20xx`、`30–99 → 19xx`。
   - Guard 版本提升到 `.12`。

两项修复都先增加失败回归，再修改实现。没有重试已消费的真实请求。

## 验证

- `npm run test:classification`：196/196 通过。
- `npm run typecheck`：通过。
- `npm run test:classification:secret`：通过。
- `git diff --check`：通过。
- 精确离线重放：g001、g025 的原始真实响应在 `.12` 下 2/2 通过；`externalCalls=0`、`credentialsRead=false`、`additionalCostCny=0`。

## 证据路径

- 首个真实运行：`/private/tmp/sgx-d4-qwen37-v31-r5-exploration6-real-run-20260929`
- 剩余五例真实运行：`/private/tmp/sgx-d4-qwen37-v31-r5-remaining5-real-run-20260929`
- `.12` 精确离线重放：`/private/tmp/sgx-d4-qwen37-v31-r5-exact-offline-replay-v12-20260929`
- 详细报告：[自动分类与归纳 T0：真实模型工程探索报告](../algorithms/CLASSIFICATION_T0_REAL_MODEL_REPORT_2026-09-29.md)

## 结论与限制

真实 Provider 和 Guard 的工程链可以继续进入本地产品接线。当前结果来自真实模型处理合成场景，不能称为真实家庭准确率、真实 OCR 效果、人物识别效果或产品收益。

`.12` 只做了保存响应的精确离线验证，没有新的真实模型请求。g007 truth 过窄、g011 多报冲突、g023 多标签口径和 g025 漏 OCR 年份应先独立复核；不继续针对 6 个样例反复调规则，避免过拟合。

## 下一任务

1. 独立复核上述四个语义/真值分歧并冻结评分口径；
2. 将真实 Stage A Provider 通过服务端 adapter 接入 `/classification-lab`；
3. 本地完成上传、AI 整理、复核、删除、撤权和失败恢复的 `T1-Local Product Alpha` 页面验收；
4. 冻结 `.12` 后，再申请 14 组 `t1_validation` 的一次性调用授权。

上述工作已整理为可执行的分阶段计划：[SGX 自动分类与归纳：下一阶段执行计划](../superpowers/plans/2026-09-29-classification-next-execution-plan.md)。后续系统审计发现原计划需要先增加 E0 持久证据 registry，并修正时间角色、幂等身份、运行中取消和评分功能 Gate。当前以 [问题总表与修订执行计划](../algorithms/CLASSIFICATION_CURRENT_ISSUES_AND_EXECUTION_PLAN_2026-09-29.md) 为最新入口。

## 后续系统审计更正

- 现行 `.12` Prompt 规定 `capture` 只能来自可信原始 EXIF；此前把 g007 的用户/ASR“照片拍于”评为更适合 `capture` 的文档判断已更正为 `event`。
- 文档引用的 r5 冻结包、两个真实运行目录和 exact replay 目录位于 `/private/tmp`，当前均已不存在。旧报告和提交保留，但无法再执行旧响应 exact replay；下一批必须先写入持久受控 artifact 根。
- Lab 的 run identity 当前未包含 Provider/model/prompt/scorer，同输入切换真实 Provider 会命中旧 deterministic job；同步 POST 也无法在模型运行中执行取消/撤权。这两项已列为 E3 前置设计。
- 当前受限沙箱复验：`typecheck` 和 secret scan 通过；分类测试非 HTTP 168/168 通过，另 28 项因 `listen EPERM 127.0.0.1` 未能运行。历史受控 loopback 环境的 196/196 记录仍保留，代码改动后需在允许 loopback 的环境重新全量验证。
- r5 的独立审计 PASS 只表示数据包结构、checksum、分区和路由完整；语义 truth/scorer 审计仍未完成。

下一项实际工作调整为 E0：建立持久 artifact registry 和新批次输出规范；随后进行不看模型输出的 truth/scoring 盲审，再实现 scorer v2 与 Lab Stage A adapter。

## E0 持久产物登记实现

已新增 `sgx-artifact-registry.1` strict Schema、离线 writer/verifier、CLI 和旧临时产物缺失 ledger。正式 CLI 默认拒绝 `/tmp`、`/private/tmp`、Git 工作树、宽权限目录、路径逃逸、符号链接、硬链接、未登记文件和 registry 覆盖；registry 只保存路径、字节数、SHA-256、版本身份、授权摘要与 provenance，不复制媒体、用户正文、raw response 或凭据。

四个已经不可访问的历史 `/private/tmp` 目录均登记为 `summary_only + do_not_reconstruct`，没有从 Markdown 汇总伪造 raw response、digest 或 usage ledger。

验证结果：

- artifact registry 聚焦测试：82/82 通过；
- `npm run typecheck`：通过；
- `npm run test:classification:secret`：通过；
- CLI `--help` 与三个 `.mjs` 语法检查：通过；
- `git diff --check`：通过；
- `npm run test:classification`：250 pass / 28 fail；28 项均为当前沙箱禁止 `127.0.0.1` 监听的已知 `EPERM`，未发现额外逻辑失败。

一次直接运行 `schema.test.mjs` 因没有设置由总测试脚本生成的 `CLASSIFICATION_BUILD_DIR` 而按设计拒绝；随后通过正式 `npm run test:classification` 入口完成 Schema 加载验证。这不是产品或 Schema 故障。

独立终审在修复真实 lane 身份/授权、`/var/tmp`、跨 run 来源、任意 Git checkout、必需 artifact role 和敏感级别六类缺口后，未发现剩余 P0/P1。E0 核心可以提交。尚未完成的是 Stage A runner 的自动 finalization；在接线前，真实执行清单必须显式运行 registry create + verify。该检查点记录的下一项是 E1 truth/scoring 盲审与 `sgx-scoring-policy.2` 冻结；其后续完成状态见下节。

## E1 语义与评分口径冻结

E1 已完成语义契约冻结，供 E2 实现可执行 scorer 使用；本阶段没有实现 scorer，也没有完成 `T0-Synthetic Functional Gate`。冻结产物包括 scoring policy、truth、scoring cases 三份 strict Schema，policy、truth、正反 fixture、盲审 ledger 和逐文件 SHA-256 freeze manifest。新 truth revision 为 `sgx-truth.2.v3-derived-e1-2026-09-29`。

四个争议样例完成 input-only 盲审。g025 的用户说明继续支持 `event:1998-summer`；图片像素中的 `2001-07` 因没有 EXIF 或流程 provenance，被保留为 `role_unknown` 观察并进入时间角色澄清，不再冻结成同角色时间冲突。这是新的 v3-derived truth revision，不会改写历史 r5 truth，也不会把原始 6 次调用中的 g025 `UNSUPPORTED_TIME_PRECISION`、漏 OCR 或其他失败状态改成成功。

E1 的 claim boundary 固定为 `synthetic_functional_only`：它只能证明合成输入上的语义合同、风险分类和冻结流程成立，不能证明真实家庭准确率、真实 OCR 效果、跨家庭泛化或产品收益。旧 r5 和 6 次调用的原始 `/private/tmp` 产物仍然缺失，因此当前不能做历史 r5 exact rescore；只有后续按原 hash 找回原始响应，才能追加独立复算报告。

聚焦验证：

- `node --test harness/classification/semantic-scoring-v2.test.mjs`：6/6 通过；
- 覆盖三份 Schema、policy/盲审 ledger hash 绑定、七类语义 fixture、固定分母状态、g025 `role_unknown` 防升级和 freeze manifest 文件哈希；
- 本阶段 `externalCalls=0`、未读取 API 凭据、额外费用 ¥0。

全量分类回归在允许 loopback 的受控环境复跑为 284/284 通过、0 fail、0 cancelled。此前一次运行曾出现 282 pass / 1 fail / 1 cancelled：HTTP expired-cache 用例预期 200、实际 409，随后 CLI shutdown 超时；本次未复现，因此保留为历史间歇性记录，不再列为当前 blocker。

下一项离线主线为 E2：让版本化 scorer 读取已冻结 policy/truth，产出固定分母报告并完成相应回归。E2、E3 仍是计划，不得从 E1 产物存在推断为已完成。

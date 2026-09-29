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
3. 本地完成上传、AI 整理、复核、删除、撤权和失败恢复的 T0 页面验收；
4. 冻结 `.12` 后，再申请 14 组 `t1_validation` 的一次性调用授权。

上述工作已整理为可执行的分阶段计划：[SGX 自动分类与归纳：下一阶段执行计划](../superpowers/plans/2026-09-29-classification-next-execution-plan.md)。计划明确 E1–E3 为零付费离线工作；只有真实 Provider adapter 通过 mock transport、保存响应重放和安全门禁后，才分别申请 E4 页面真实模型冒烟与 E5 冻结 validation 的授权。

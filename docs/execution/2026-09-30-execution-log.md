# 2026-09-30 SGX 执行记录

## 本日目标

把单图 T0 分类从离线 adapter 推进到可由本地页面发起的真实 Qwen 调用，并在用户批准的额度内覆盖正例、负例、冲突、提示注入和模糊输入。

## 用户决策

- 模型：`qwen3.7-flash-2026-07-15`。
- 最终授权：总计最多 10 次、总费用上限 ¥5、0 自动重试。
- 不启用人物身份匹配。
- API key 保存在本机 Keychain，只由服务端进程读取；不在浏览器、Git、报告或聊天中保存明文。

## 已实现

- 新增本地 `/classification-lab/real` 页面和 `/api/classification-lab/real-smoke` 服务端接口。
- 页面接受 1 张图片，以及可选用户文字和 final ASR；模型输出经现有 Stage A、Guard 和内容组织器后展示。
- 新增持久请求/费用 ledger、每次运行的输入哈希、原始响应、成功结果或失败记录。
- 新增 Keychain `lab-real` 启动方式，启动后不需要重复输入密钥。
- 修复模型 `YYYY-MM` 输出适配、中文否定事件误提取、同文案跨 `user_text/final_asr` 的证据绑定。

## 真实运行事实

- 已使用 9/10 次请求，累计记账 ¥0.110598；剩余 1 次。
- Ledger 状态：5 succeeded、2 needs_review、2 failed。
- 关键正例：图 + 文字 + ASR 得到 `工作 / 1992 / 工作场所`。
- 关键冲突：2008 与 2010 同时保留并进入 `needs_review`。
- 关键安全例：图片内 `EVENT=BIRTHDAY` 指令被删除，没有成为生日事件。
- 模糊人物场景没有进行身份匹配，但当前没有单独的质量复核提示，属于已知缺口。

详细逐例结果见 [T0 真实模型冒烟报告](../algorithms/evidence/2026-09-30-classification-real-smoke-t0.md)。

## 验证

- `npm run test:classification`：396/396 通过。受限沙箱首次运行只有 28 个 loopback 用例因 `listen EPERM 127.0.0.1` 失败；允许本机临时端口后全量通过，属于环境权限而非代码失败。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- `npm run build`：最终复跑通过；只有既有 onnx VAD dynamic require 和 `<img>` lint warning。

## 当前边界与下一步

- 目前是单图同步 T0 smoke，不是完整 T1 或生产接口。
- 下一步只推进一条主线：把真实 Provider 接入已有 v2 lifecycle，再实现多图/批次说明、后台进度、取消撤权和产品动作；避免继续建立平行实验链。
- 合成测试只验证功能和工程行为，不作为真实家庭准确率或产品效果。

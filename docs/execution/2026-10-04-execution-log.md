# 2026-10-04 SGX 自动分类与归纳执行日志

## 今日目标

完成结果上传租约缺陷修复、远端不可变发布、一次新的真实多图验证，并把可审计结论更新到全栈交付分支。

## 已完成事实

1. 在开始本轮改动前，`codex/classification-contract-v1` 已以 `c1e4bbd` 推送到 `GOATWEN6/SGX-classification`，全栈工程师可以先读稳定契约与文档。
2. 恢复了因本地控制平面重启而中断的 `lab_run_688fa535be302a7c4e04e01b`。远端 provider 审计确认该 Job 没有发生付费调用，状态被保守归档为 `failed_retryable / LAB_RUN_INTERRUPTED`。
3. `lab_run_c4c628cfc2517119f9272789` 实际完成 3 次 Qwen 调用，但在结果上传阶段失败。根因有两个：
   - Worker 在上传前已通过 heartbeat 获得新租约，却仍使用最初租约中的旧 `resultUpload.expiresAt` 做本地判断；
   - provider 使用量只在上传成功后保存，因此上传失败时错误上报为 0 次调用。
4. 修复提交 `4a904f413c017e0fc576d8bdb3ef8d1edcfe9486`：
   - 上传是否有效由上传前 heartbeat 与服务端 authoritative fence 判定；
   - processor 返回后立即保存已知 provider usage，后续上传失败也能准确结算。
5. 本地门禁：分类回归 `535/535`、Worker `34 pass / 0 fail / 1 skip`、TypeScript typecheck、密钥扫描和 `git diff --check` 均通过。
6. 远端新发布 `4a904f4...` 已在 `/gemini/code/sgx-classification/releases/` 冻结并取得 `VERIFIED`：
   - 两个新增回归 `2/2`；
   - 部署/回滚夹具通过；
   - 372 项发布文件哈希通过；
   - 前两次因“仓库源码路径不存在于发布包布局”产生的测试失败日志被保留，没有覆盖；
   - `current` 已切换到 `4a904f4...`，`previous` 保留 `c1e4bbd...`。
7. Feature Service 曾因 VirtAI/Orion 一小时 idle timer 退出，已使用既有离线环境和持久模型重启；未下载任何模型。该限制已写入部署文档。

## 真实模型验证

最终验证 Job：`lab_run_e8fd529c4610565d899e94c5`

- 输入：2 张合成家庭场景照片 + 1 条明确绑定两张图片的用户文字；人物匹配已授权并开启。
- 真实模型：`qwen3.7-flash-2026-07-15`。
- Prompt：`sgx-five-facets.16`。
- Worker 发布：`4a904f413c017e0fc576d8bdb3ef8d1edcfe9486`。
- 结果：`succeeded`，结果成功上传并持久化。
- 延迟：`37,792 ms`。
- 调用：3 次；三条 provider 审计均为 `finish_reason=stop`。
- Token：输入 `12,664`，输出 `3,151`。
- 费用：`¥0.0303216`，账本按微元向上结算为 `¥0.030322`。
- 组织结果：1 个 `StoryUnit`，包含两张图片与用户原文；AI 标题为“兴趣活动”，摘要为“共3项内容；记录兴趣活动。”
- 规则结果：图片间形成 `same_event / ai_auto`；由 embedding 单独提出的 `same_story` 候选因证据不足保持 `not_selected`。
- 人物能力：两张图各检测到 3 个匿名人脸候选，并产生 `face_embedding_topk`；没有输出姓名或亲属关系。
- 其他能力：产生 `image_text_embedding_topk`，Feature Service 组件错误为 0，复核项为 0。
- 历史候选：0；本轮使用新 household，因此不用于证明跨轮历史召回。

本轮真实调用后的累计账本：`164` 次 / `¥22.931574`，剩余 `36` 次 / `¥2.068426`，自动重试为 0。

## 结论边界

- 已证明真实 Qwen、真实 OCR/embedding/face、规则组织、结果上传和文件持久化能在同一主链运行。
- 已证明本次租约续期后上传问题得到修复。
- 本轮媒体是合成数据，所以结论是功能链验证，不是现实家庭照片准确率、人物身份准确率或真实用户效果。
- 当前仍是 T0/T1 internal release candidate。产品后端的账号鉴权、业务数据库、对象存储、队列/outbox、正式监控和高可用部署属于 T2。
- VirtAI Notebook 当前会受 idle timer 影响。内部用户服务必须增加持久 supervisor/健康恢复，或迁移到不会自动回收进程的推理部署环境。

## 下一步

1. 产品负责人可在 `http://127.0.0.1:3137/classification-lab/t1` 继续进行人工上传体验。
2. 全栈工程师按仓库契约实现 T2 control plane 与持久化，不需要复制实验室文件存储。
3. 在额度内优先做跨轮历史召回、原始语音 ASR 和撤权/取消的代表性真实链验证；不为凑调用次数重复同类样本。

## T1 产品体验补齐

用户人工体验时发现两个实际缺口：T1 页面只有上传 WAV 的 ASR 调试入口，且分类结果虽显示在页面下方，但没有独立的智能相册入口。本轮按产品真实使用方式补齐：

1. `/classification-lab/t1` 新增浏览器麦克风录音。用户点击开始、说话、点击结束后，浏览器把采集到的单声道 PCM 编码为 16 kHz/16-bit WAV，再送入既有真实 SenseVoice ASR pre-job；识别成功后把最终转写填回可编辑文本框。
2. WAV 文件上传保留在折叠的“开发调试”区域，不再作为正常用户的主入口。
3. 新增 `/classification-lab/t1/album`，读取当前浏览器会话对应的服务端持久化 Job，按 StoryUnit 展示照片、用户原文、最终 ASR、AI 标题、摘要和标签；未完成过分类时明确显示空相册。
4. 新增 WAV 编码与页面接线回归；TypeScript typecheck 通过，完整分类回归 `537/537` 通过。
5. 浏览器已验证两个新入口可见、智能相册页面可打开。真实麦克风音频必须由用户主动授权并说话，因此尚未代替用户采集语音，也未把页面可见升级为真实老人语音质量结论。

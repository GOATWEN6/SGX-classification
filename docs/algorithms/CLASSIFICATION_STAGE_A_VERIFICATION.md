# 自动分类阶段 A：本地验证记录

## 2026-09-23 可信输入适配更新

本轮在当前隔离分支新增可信 Evidence 到 Stage A 的后端适配器，并冻结 [集成 Spec](../superpowers/specs/2026-09-23-classification-stage-a-integration-spec.md)。适配器把完整 Evidence 目录、图片正文、独立用户文字和最终 ASR 转换为内部 `Request`，同时返回授权快照、受限图片 resolver 和 audit 映射；它不访问数据库、不启动队列、不调用真实模型。

新增 `harness/classification/stage-a-adapter.test.mjs` 7 项回归：独立来源保留、精确引用、Mock Provider 链路、跨 scope、缺失/哈希错误、未绑定/重复绑定、删除墓碑与 partial ASR。适配器实现和来源契约的提交为 `e8baece`，Spec 提交为 `8f23d43`。后续完整分类回归应包含这些用例；仍需把本轮文档更新和最终回归结果记录在下面的最新检查表中。

日期：2026-09-14。工作树 `/Users/wenqingzhong/.codex/worktrees/f899/SGX`，分支 `codex/classification-contract-v1`，基线 HEAD `d33a5c5`。新增与之前 Fake HTTP 的改动仍在工作树，未 commit/push/PR/merge/部署；未修改业务前端、业务数据库、依赖锁文件或其他 checkout。

状态更新：2026-09-22 已完成工程复审，并把核心实现与测试保存为本地提交 `505c274`；仍未 push、创建 PR、merge 或部署。

## 结论

阶段 A 的算法编排、API 适配边界、增量/纠错、新版 HTTP 和离线评测工具已实现，并通过本地检查；总控审阅发现的单次超预留保护偏差已修复。**97 项通过是工程证据，不是 97 张照片识别正确，更不是算法准确率。**真实 API、真实家庭照片和全栈产品验收尚未进行。

|检查|实际结果|证据|
|---|---|---|
|`npm run test:classification`|97/97，通过；0 失败、0 跳过；约 3.45 秒|`/private/tmp/sgx-reservation-green.log`|
|其中既有契约/Fake/lifecycle|50 项回归保留在完整运行中|同上|
|其中阶段 A 新增|47 项：编排27、HTTP3、预检/计分/批次11、预算6|同上及各 stage-a*.test.mjs|
|`npm run typecheck`|退出码 0|`/private/tmp/sgx-reservation-typecheck.log`|
|`npm run test:classification:secret`|voice secret scan ok，退出码 0|当前执行输出；仅表示既有扫描规则未命中|
|`npm run classification:stage-a -- --smoke`|健康检查→POST→3 次 Mock API 请求→事件组→关闭成功|`/private/tmp/sgx-stage-a-smoke.log`|
|`npm run classification:eval -- --help`|退出码 0；显示默认离线入口|`/private/tmp/sgx-stage-a-eval-help.log`|
|评测 CLI 实际预检/无授权阻止执行|已纳入回归：写出 offline preflight；无 approval 的 execute 返回 APPROVAL_REQUIRED|stage-a-eval.test.mjs|
|`git diff --check`|退出码 0|当前执行输出|

早期普通沙箱运行曾为 70 项中 46 通过、24 个 HTTP 测试因本地监听 EPERM 失败，记录保存在 `/private/tmp/sgx-stage-a-first.log`。经平台批准允许回环监听后继续运行，73/73、82/82、87/87 和初次交付 89/89 通过。没有通过跳过 HTTP 测试消除失败。

## 审阅修复：单次实报超预留

总控用输入预留 24,580、实报 50,000 Token 的调用复现：原实现只检查总上限，允许继续调用，与 D4 的停止承诺不符。新增回归先得到 97 项中 91 通过、6 失败，日志 `/private/tmp/sgx-reservation-red.log`；修复后完整 97/97。

现在每次调用保留 reservation（输入、输出、费用）和实报 usage，单次输入或输出严格超过预留即标记 `RESERVATION_OVERRUN` 及 reservationExceeded；若同时超过整批上限，仍以 `BUDGET_OVERRUN` 表达并保留超预留维度。真实用量和费用不会改回预留或截断。该 TaskBudget 停止后拒绝再次 invoke；编排终止，批次剩余任务记录 not_run 并保留评测分母。

新增 8 项覆盖：输入超预留、输出超 2,048 请求预留（均未超过总限额）的预算对象拒绝及真实模式编排停止各 2 项；真实模式批次 CLI 停止各 1 项；等于预留可继续 1 项；无 usage 失败仍按预留记账 1 项。所有“真实模式”测试都用本地 invoke 桩替换网络入口，不读取凭据、不调用真实模型；批次用例明确断言只有 1 次调用、后续任务未执行和实际 Token 原样保存。

日志是本机临时文件，可能被系统清理；以上持久记录保留结论，测试命令及源码可复现。未产生真实模型结果文件或真实账单。

## 本轮证明了哪些行为

- 同一次生日的多场景图可以形成事件候选；不同年份生日、同日同地不同活动有区分和阻止错误合并的测试。
- 新图可进入历史事件；说明变化重算该图并复核相关历史关系；纯查看复用有效缓存并保留待确认状态。
- 未知人物可以先分组，再用用户参考命名；组内其他照片仍是身份候选。拒绝、拆分和改名不被模型静默覆盖。
- 人脸局部 ID 变化时按原图哈希与区域重锚定。锚定失效则待确认并限制相关 AI 人物合并，保留拒绝保护。
- 合并/拆分 ID 不重复；旧组退休与 supersedes 可供全栈处理。人物匹配候选被拒绝的关系不会在说明变化后重新生效。
- 跨家庭、同家庭不同主体、伪造指认记录、未授权素材及擅自省略完整目录均被拒绝；撤回、取消、超时和并发旧结果不能保存快照。
- 新模型/Prompt/素材版本使缓存失效；无模型、预算耗尽、非法输出和返回模型不一致均有显式错误。真实模式首个工程错误停止任务，保留失败记账。
- 新 HTTP 经过实际编排/API 请求构造，Mock transport 接收真正的多图消息格式；它没有调用远程服务。
- 评测预检核验图片/真值哈希、事件/近重复分区、具体批准绑定；计分保留漏召回/失败分母，按框匹配人物，不偷用模型 faceId 当真值；增量任务可冻结各自证据版本的真值。

## 不能据此宣称的结果

|层级|当前状态|
|---|---|
|算法实现与本地工程检查|本轮完成，带已知限制|
|真实供应商调用兼容性/成本/时延|未执行，D4 待具体授权|
|真实老人/家庭身份与事件效果|未验证；尚无获准外发并独立审阅的完整材料|
|可靠自动归组条件|未校准；代码规则不是效果门槛|
|业务事实编辑与持久化|未接入；由全栈保存独立确认记录|
|产品全流程、Memory/访谈、ASR/TTS/VAD|未在本轮验收|

当前最值得后续核验的是：VLM 对老人跨年龄和翻拍的表现；有界候选筛选漏召回；跨天事件保守规则导致误拆；输入冲突/无依据精确信息的真实发生率。先执行 [D4 有界探索](CLASSIFICATION_D4_PROPOSAL.md)，再据失败调整，暂不扩充数据库、队列或自部署模型。

全栈运行、契约及人工验收见 [阶段 A 交接](CLASSIFICATION_STAGE_A_HANDOFF.md)。

## 2026-09-22 工程收口复审

本次不调用真实 API，只审阅当前工作树并补充能复现实际风险的回归。发现并修复两类工程缺陷：

1. `stage-a-http.ts` 原先只用 `runId` 保存运行记录。两个不同家庭或主体使用相同 `runId` 时，后一作用域会被错误阻塞。现在运行键绑定完整 `scope + runId`，取消接口也按当前已认证作用域定位任务。
2. 模型输出和独立真值原先允许 `conflicts` / expected facet 重复。重复项可能制造重复人工提醒或放大 unknown/conflict 计数。现在模型输出拒绝重复冲突维度，D4 真值同时拒绝重复 unknown/conflict 维度。

新增 3 项回归后，`npm run test:classification` 为 **100/100 通过，0 失败、0 跳过，约 4.45 秒**。`npm run typecheck`、`npm run test:classification:secret` 和 `git diff --check` 同步通过。测试仍只使用合成 fixture 与 Mock transport；以上修复不构成 Stage A 真实模型效果验证。

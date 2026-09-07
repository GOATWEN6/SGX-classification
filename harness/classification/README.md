# 多模态分类契约 harness

本目录全部为合成元数据与确定性 Fake 输出，不包含媒体原件、真实家庭信息或真实模型结果。它是全栈接入的第一批基础，不能报告分类准确率，也不代表上传/确认 UI 已打通。

在仓库依赖可用的 Node 22 环境中运行：

```sh
npm run test:classification
npm run typecheck
npm run test:classification:secret
npm run classification:demo -- success
npm run classification:demo -- conflicted
npm run classification:demo -- timeout
```

测试脚本使用现有 TypeScript 编译器，将分类模块和 Schema 编译到临时目录，然后运行 Node 原生测试并清理临时产物。无需启动 Next.js、配置凭据或联网。其他演示参数：`needs_review`、`failed`、`invalid_output`、`partial_failure`。`failed` 默认可重试；构造 Fake 时可用 `failureCode: 'UNSUPPORTED_INPUT'` 演示终止失败。

本工作树验证时通过本地 `node_modules` 软链接只读复用主目录已有依赖，没有安装或下载软件；该链接不进入 Git。新 checkout 仍按仓库锁文件准备依赖后运行上述命令。

## 全栈接入顺序

1. 上传 API 在服务端重验对象归属、MIME、字节/像素、checksum、当前主体和 consent，创建 Evidence 与 ContentBundle。这里只接受 JPEG/PNG/WebP、文字引用、最终 ASR 引用，最多 20 条证据；这不是图库容量变更。图片上限 20 MiB、4000 万像素；文本/转写 64 KiB。格式扩展应先改契约。
2. 后端授权服务生成 `AuthorizationContext`，逐条核验 actor 对 evidence、subject、household、圈层及 consent 的权限。这个对象不能直接来自客户端。`allowedEvidenceIds` 代表本次处理权限，不是客户端提交的白名单。
3. 调用 `prepareProviderRequest(bundle, options, authorization)`。输入 `FAKE_VERSIONS`、requestedFacets、截止时间、配置哈希；返回最小 Provider 请求。`giftScenario` 不成为证据。对象仍使用受保护逻辑引用，Fake 不解引用；真实 Provider 的受控读取适配器尚未实现。
4. 后端以返回的 `idempotencyKey` 在事务/唯一约束中查找或创建 Job；同 key 命中也必须重新检查权限。Job 状态使用 `pending → processing → succeeded/needs_review/failed_retryable/failed_terminal/cancelled`。重试次数、原子去重和队列由后端实现。
5. 调用 `executeProvider(request, new FakeClassificationProvider({ scenario }), { signal })`。最迟在请求 deadline 或 60 秒上限返回。它把异常原文隔离为稳定错误码、取消本次 Provider、丢弃晚到完成；不自动重试，不落库。对不合作的 Provider 只能尽力停止其工作，仍可保证晚到输出不会改变已返回的结果。
6. Provider 结果在保存前，通过 `acceptProviderResult(request, output, freshSnapshot)` 检查当前 processing/runId、授权、证据版本和截止时间；校验和写入必须在同一事务中完成。任何过期 Provider 输出均拒收。runner 产生的超时/取消是产品层本地决策，后端应以同一 run 的原子状态转换记录，不把它作为 deadline 后的 Provider 输出送回 acceptance。取消或删除墓碑已有终态时，不得再覆盖。
7. 展示合成候选时明确标识 Fake。`succeeded` 表示本次处理成功；语义 Assertion 仍是 `proposed`，没有成为真实人生事实。`needs_review` 可同时带候选、facetErrors 或 abstentions；逐 facet 显示缺口。`conflicted` 用同一 conflictGroupId 保留两个判断及来源。
8. 用户操作使用 `AssertionReviewRequest`：`confirm/edit/reject/withdraw`、`expectedRevision`、本人/明确代理身份和 authorityRef。后端须验证当前权限、值与 facet 匹配、版本冲突及审计，成功后更新 Assertion 版本；拒绝/撤回不得写 Memory。此处只提供审核请求 Schema，未实现 review service。现有 `src/lib/memory/index.ts` 只用 userId，不能直接接入新主体/家庭模型。

入口：`src/lib/algorithms/classification/{types,validation,guards,provider,fake}.ts`。以上为服务端模块，客户端只使用生成类型和产品 API 视图，不导入 runner/guards。

## fixtures 与检查边界

- `fixtures/positive-v1.json` 是基础对象和组装模板；其中 bundle/provider 的 evidence 占位列表需由 `schema.test.mjs` 或 demo 组装。只有 `prepareProviderRequest` 会生成可运行的真实输入哈希，模板内哈希仅用于结构测试。
- `fixtures/invalid-mutations-v1.json` 给出基础对象路径和精确变更；`schema.test.mjs` 验证应拒绝的结构，并额外测试 JSON 无法表示的 NaN。
- `fixtures/semantic-rejection-v1.json` 区分 Schema 合法但需要业务拒绝的案例。处理授权、跨域和晚到结果在 `provider.test.mjs` 中有运行测试；review 权限过期仍是全栈后续验收项，不冒充已覆盖。
- `provider.test.mjs` 实际执行各 Fake 场景、请求最小化、key 变化、来源/状态/版本拒收、取消/超时及过期结果保护。
- `classification-types.mjs --check` 从唯一 JSON Schema 重新生成完整文本比较，防止类型和枚举漂移。类型无法表达数值范围等约束，运行时仍需 `parseContract`。

人脸字段只表示合成 F1 区域或受 consent 约束的匿名簇。F2 返回的 faceRegionIds 必须引用同次结果中的 F1 区域；不接受任意外部簇/人物库引用。真实 F1/F2 推理、模板存储、命名和纠错未实现。文本提及只允许 user_text/final_asr 支持；Fake 的姓名样式文字也是合成占位，不是从输入提取。

本批未验证：完整 API ACL/IDOR、上传与对象存储、并发 10 次只创建一条 Job/Assertion、取消/重试持久化、review 版本竞争、Memory 转换、原件/衍生物/缓存/研究导出的删除传播、浏览器 E2E、Python/Android 校验及真实算法效果。后续全栈验收需逐项补齐，不把 key 稳定测试称为数据库去重，也不把拒收删除证据称为完成物理删除。

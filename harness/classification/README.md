> 2026-09-14：本页以下描述 v1 契约/Fake。新增五维、人物/事件聚合与增量 HTTP 请读 [阶段 A 交接](../../docs/algorithms/CLASSIFICATION_STAGE_A_HANDOFF.md)，真实实验入口请读 [D4 方案](../../docs/algorithms/CLASSIFICATION_D4_PROPOSAL.md)。v1 与新版的实现/未实现状态不可混用。

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
npm run classification:fake-http
npm run classification:t0-preflight -- --manifest /受控目录/manifest.json
npm run classification:semantic-score -- --policy /绝对路径/policy.json --truth /绝对路径/truth.json --cases /绝对路径/cases.json --out /绝对路径/新目录
```

## E1 semantic scoring v2

E1 新增三份 strict draft-07 Schema：

- [`classification-scoring-policy-v2.schema.json`](../../contracts/classification-scoring-policy-v2.schema.json)
  冻结七类语义结果、匹配顺序、固定分母、安全 Gate、时间角色和冲突规则；
- [`classification-truth-v2.schema.json`](../../contracts/classification-truth-v2.schema.json)
  约束 input-only 盲审真值、输入哈希、policy/盲审 ledger 绑定以及逐样例来源；
- [`classification-semantic-scoring-cases-v2.schema.json`](../../contracts/classification-semantic-scoring-cases-v2.schema.json)
  封闭 case 输入和期望字段，要求显式 `evidenceKinds`、time role/precision、workflow assessment、固定分母
  以及 policy/truth bytes hash。

配套 fixture 为：

- [`semantic-scoring-policy-v2.json`](fixtures/semantic-scoring-policy-v2.json)：冻结 policy；
- [`semantic-truth-v2.json`](fixtures/semantic-truth-v2.json)：`g007/g011/g023/g025` 的 synthetic
  functional truth；
- [`semantic-scoring-v2-cases.json`](fixtures/semantic-scoring-v2-cases.json)：覆盖七类语义、完整与
  不完整冲突以及 `failed/not_run` 固定分母的正反例期望。

只运行 E1 focused test：

```sh
node --test harness/classification/semantic-scoring-v2.test.mjs
```

`npm run test:classification` 也会自动包含该测试。focused test 的 6 个检查覆盖三份 strict Schema、
fixture、policy/truth/盲审 ledger 哈希绑定、引用完整性、七类语义、`failed/not_run` 固定分母、
`g025` 时间角色保护与 freeze manifest；这个 E1 测试不执行 E2 scorer，也不验证真实模型效果。

本轮不产生 aggregate score：policy 固定 `aggregateScore=null`，功能 Gate 的
`numericPassThreshold=null`，只要求按语义类别计数、固定分母、逐 facet 明细和 workflow status。
旧内容组织 baseline 的 `0.80/0.55` 只用于 `autoMerge/candidate` 路由，不是模型置信度、真实准确率或
semantic scoring v2 的通过线。`g025` 图片中可见的 `2001-07` 仅是 `role_unknown` observation；
没有可信 provenance 时不能升级为 `event/capture/scan/upload`，也不能据此制造时间冲突。

policy 与 truth 的 `claimBoundary` 都是 `synthetic_functional_only`，case fixture 进一步标记为
`offline_contract_fixture_only`。因此它们只能验证合成数据上的结构、功能规则和异常处理；synthetic
functional truth 不代表真实模型准确率、真实家庭分布表现、产品就绪或用户收益。

## E2 semantic scorer v2

E2 纯函数评分器位于 [`semantic-scoring-v2.mjs`](semantic-scoring-v2.mjs)，版本为
`sgx-semantic-scorer.2.0.0`。它读取 E1 冻结 policy/truth，先校验 provenance，再执行七类语义匹配；
`role_unknown` observation 与 Assertion 七类计数分开，合法冲突候选由冲突通道消费，
`failed/not_run` 仍保留在固定分母。实现不按 `groupId` 或具体样例 ID 分支。

只运行 E1 + E2 focused tests：

```sh
node --test harness/classification/semantic-scoring-v2.test.mjs \
  harness/classification/semantic-scoring-v2-implementation.test.mjs
```

CLI 的 `--cases` 模式只做冻结 oracle conformance；`--run` 模式接收
[`classification-semantic-runtime-v2.schema.json`](../../contracts/classification-semantic-runtime-v2.schema.json)
约束的单次 runtime 输入。地点预测必须显式提供 `placeKind=named|generic`，终态 `failed/not_run`
不得携带可计分输出。两种模式均绑定输入原始 bytes、policy、truth 和 scorer hash，并拒绝覆盖已有目录。

冻结的 16 个 oracle cases 全部由评分器实际执行。它们包含故意错误输出，因此报告 safety Gate 是
`not_applicable_oracle_fixture`，不是产品安全通过或失败。报告保持 `aggregateScore=null`，功能数字阈值
仍为 `pending_real_data_calibration`。CLI 不读取密钥、不联网、不调用模型；它不执行旧 r5 exact rescore，
也不证明真实准确率、泛化能力或产品闭环。

## 实验产物登记（E0）

真实模型探索、离线 replay 和冻结评测必须写入 Git 外的持久私有目录；`/tmp`、`/private/tmp`
和仓库内部目录会被正式 CLI 拒绝。先在运行目录外准备一份 definition，再创建和校验 registry：

```sh
npm run classification:artifacts -- create \
  --definition /持久私有目录/registry-definition.json

npm run classification:artifacts -- verify \
  --registry /持久私有目录/<run-id>/artifact-registry.json \
  --expected-hash sha256:<创建命令返回的哈希>
```

definition 的 `outputRoot` 指向单次 run 目录；`artifacts[]` 必须列出该目录内除
`artifact-registry.json` 以外的全部文件。definition 本身应放在 run 目录外，除非也把它明确登记为
artifact。writer/verifier 只在本地计算路径、字节数、SHA-256、版本身份、授权摘要和 provenance；
不会读取凭据、联网、调用模型或复制 payload。完整字段、权限和 evidence lane 见
[`2026-09-29-classification-artifact-registry-spec.md`](../../docs/superpowers/specs/2026-09-29-classification-artifact-registry-spec.md)。
真实模型 lane 必须填写模型身份和授权摘要；离线 replay 必须用 `sourceRegistryRefs` 锚定父 registry 的
ID、bytes hash 和来源 artifact，不能把无来源的手工结果标记为 replay。
CLI 会检查 `outputRoot` 的全部父目录，任何 Git repo 或 worktree 内的目录都会被拒绝；每种 lane
还必须包含规范列出的 manifest、truth、scorer、ledger、metrics、report 等证据角色。真实执行未发出
请求时，`provider_response` 可为空文件，但 ledger 必须记录 0 请求、0 费用和停止原因。
`provider_response` 永远是 `restricted`；真实用户 lane 的证据文件除纯规则与 checksum 外至少是
`private`，不能由调用方降级为 `metadata_only`。

这项检查只证明实验文件完整、来源可追溯。它不证明模型准确率、真实家庭泛化能力或页面产品闭环。

`classification:t0-preflight` 只读取本地受控目录，不读取密钥、不联网、不调用模型。真实素材目录结构、
真值字段和 30–50 组覆盖要求见
[`CLASSIFICATION_T0_REAL_MEDIA_KIT.md`](../../docs/algorithms/CLASSIFICATION_T0_REAL_MEDIA_KIT.md)。
原始家庭媒体和真值文件必须保存在 Git 仓库之外。

准备 synthetic-v2 首轮真实 API 探索包：

```sh
npm run classification:prepare-eval -- \
  --archive /Users/wenqingzhong/Downloads/sgx_synthetic_photo_testset_v2.zip \
  --out /private/tmp/sgx-d4-qwen37-exploration-20260924
```

该命令只读取本地 ZIP、固定图片哈希并生成 `batch.json`、`truth.json` 和 `REVIEW.md`；不会读取密钥或发起网络请求。生成的 manifest 默认是 `draft`，必须先完成独立人工真值复核。任务可显式关闭没有独立真值的 person/pair/identity 指标；被关闭的指标在报告中显示“未评估”，不会记成通过或失败。

测试脚本使用现有 TypeScript 编译器，将分类模块和 Schema 编译到临时目录，然后运行 Node 原生测试并清理临时产物。无需启动 Next.js、配置凭据或联网。其他演示参数：`needs_review`、`failed`、`invalid_output`、`partial_failure`。`failed` 默认可重试；构造 Fake 时可用 `failureCode: 'UNSUPPORTED_INPUT'` 演示终止失败。`classification:fake-http` 会在 `127.0.0.1:8787` 启动仅用于联调的 HTTP 服务，按 Ctrl-C 停止；它不读取媒体、不持久化 Job、不调用模型。

HTTP 草案和运行方式见 [Fake HTTP 联调与验收](HTTP_HANDOFF.md)。该服务仅接受服务端预置的合成 scope / Evidence，严格校验请求，使用进程内状态模拟授权版本、撤回和结果拒收。`authorizationState: "active"` 不能覆盖服务端撤回状态；没有生产身份认证。完整相同请求（忽略 JSON 对象属性顺序）可共享执行或重放；同 key 改 runId、requestId、scenario 等字段仍返回 `IDEMPOTENCY_CONFLICT`。这只是当前 Fake 草案的严格重放语义，真实重试、请求追踪和双方最终 HTTP 契约仍待评审。

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

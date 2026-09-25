# 自动分类与归纳：完整开发差距与真实验证启动单

日期：2026-09-24  
分支：`codex/classification-contract-v1`  
证据边界：本文区分本地工程回归、真实视觉 API 探索、独立保留集、真实家庭数据和产品集成；这些层级不能互相替代。

## 1. 当前结论

分类算法已经完成可运行的工程骨架、Stage A 五维抽取与事件关联、可信 Evidence 适配、统一 ContentItem/StoryUnit 契约、Fake/Mock、HTTP 生命周期和离线评测 harness。现在距离“算法负责人可以交付的完整 v0.1”主要还差三段：

1. 当前 Stage A 使用固定真实视觉模型完成小规模探索，并根据失败修复 Prompt、适配器或候选算法；
2. 为独立文字和 final ASR 增加真实抽取 Provider，把真实观察结果接入 StoryUnit，而不是只跑 Fake 规则；
3. 用冻结的独立保留集复验，形成可支持或否定上线判断的报告。

数据库、ORM、Redis、队列、对象存储和前端页面属于全栈产品接入，不要求算法负责人先搭完，且不阻塞第一轮离线真实模型探索。

## 2. 距离完整开发还差什么

|层级|当前状态|缺口|算法 v0.1 完成标准|
|---|---|---|---|
|契约与安全边界|已实现|持续核对真实响应兼容性|真实输出仍能通过严格 Schema、来源、作用域、撤回和晚到结果校验|
|图片五维抽取|工程完成、真实效果未验证|当前 Provider 尚未用当前 Prompt 跑真实 API|探索集定位错误，修复后独立保留集过冻结 Gate|
|人物|工程链存在|没有可靠人物框、身份真值和跨年龄证据|本轮先关闭人物指标；具备独立人物真值后单独验证|
|同事件归纳|本地规则和 Mock 已实现|真实 VLM 抽取、候选召回和同事件关系未实测|同事件漏分、错并和候选漏召回使用固定分母报告|
|独立文字/final ASR|ContentItem 与规则契约已实现|缺真实文本抽取 Provider 和 Evidence→ContentItem 生产适配|文字与 ASR 可独立生成 Observation，并与图片形成 StoryUnit|
|标题与摘要|Fake 规则可生成|缺真实摘要 Provider、证据约束和效果评价|标题/摘要可追溯、不覆盖原文、撤回后失效|
|真实产品接入|未实现|鉴权、对象读取、持久化、队列、UI、删除传播、监控|由全栈负责人用同一契约完成 Web/PWA E2E|
|Memory/访谈|只冻结了边界|缺确认后的 MemoryCandidate 适配和撤回传播|只有确认、可追溯内容进入 Memory；访谈读取证据而非裸摘要|
|真实家庭效果|未开始|没有获准外发且独立标注的家庭样本|合成探索与保留通过后，再做授权 shadow/pilot|

## 3. 本次启动的真实验证

先启动 **真实模型兼容性 + 合成探索**，不直接声称真实家庭准确率。

- 数据：`sgx_synthetic_photo_testset_v2.zip` 中 10 张合成图；
- 案例：C013、C014、C022、C026、C035、C036、C037、C038、C039、C040；
- 模型：`qwen3.7-flash-2026-07-15`，关闭思考；
- 评估：时间、地点、事件、场景、unknown/conflict、同事件关系；
- 不评估：人物、人脸、quality、截图法证、正式 OCR、Memory、产品体验；
- 上限：60 请求、400 万输入 Token、13 万输出 Token、¥5、15 分钟、0 自动重试；
- 停止：传输错误、非法 Schema、模型版本变化、预算超限、错事件合并或不变项变化立即停止。

选择固定快照是为了让结果可复现。阿里云官方在 2026-09-24 可查到该模型支持图像和结构化输出；按量价格在 32K 以下为输入 ¥0.2/百万 Token、输出 ¥0.8/百万 Token，随单请求上下文增加而分档。本批清单按最高上下文档 ¥1.2/¥4.8 保守记账，不把免费额度或缓存折扣算入预算：

- <https://help.aliyun.com/zh/model-studio/vision-model>
- <https://help.aliyun.com/zh/model-studio/qwen3-7-flash>

## 4. 已完成的离线准备

生成命令：

```sh
npm run classification:prepare-eval -- \
  --archive /Users/wenqingzhong/Downloads/sgx_synthetic_photo_testset_v2.zip \
  --out /private/tmp/sgx-d4-qwen37-exploration-20260924
```

本次生成结果：

- 人工复核单：`/private/tmp/sgx-d4-qwen37-exploration-20260924/REVIEW.md`
- 真值草稿：`/private/tmp/sgx-d4-qwen37-exploration-20260924/truth.json`
- 批次清单：`/private/tmp/sgx-d4-qwen37-exploration-20260924/batch.json`
- 图片核对图：`/private/tmp/sgx-d4-qwen37-exploration-20260924/contact-sheet.jpg`
- 离线预检：`/private/tmp/sgx-d4-qwen37-preflight-20260924/preflight.json`

离线 preflight 已核对 10 张图片的实际字节哈希、truth 哈希、scope、任务结构、来源组和预算。结果只有一个预期 blocker：`MANIFEST_DRAFT`。它表示真值仍需独立人工复核，不是代码或数据损坏。预检没有读取凭据，也没有发起外部请求。

## 5. 进入付费调用前的最后门禁

真实请求前只需要完成以下一次性确认：

1. 独立复核 `REVIEW.md` 中 10 行事实，特别是两组同事件和三组冲突；
2. 将实际复核者写入 `truth.json.reviewedBy`，冻结 truth hash；
3. 将 manifest 从 `draft` 改为 `ready`，再次运行离线 preflight；
4. 批准准确模型、10 张照片清单、¥5 总上限、15 分钟有效期和不做人脸匹配；
5. 在本地环境提供 `SGX_D4_API_KEY`，密钥不进入聊天、Git 或报告；
6. 生成与 manifest 哈希绑定的 approval 后执行一次，结果原样保留，不自动重试。

## 6. 第一次真实探索结果

执行目录：`/private/tmp/sgx-d4-qwen37-run-20260924`。

|项目|结果|含义|
|---|---|---|
|真实调用|已发生 1 次|不是 Fake/Mock；响应 ID 和原始供应商响应已留存|
|模型版本|`qwen3.7-flash-2026-07-15`|请求模型与 `raw.model` 完全一致|
|停止原因|`INVALID_OUTPUT`|首张 C013 抽取失败后按规则停止，没有自动重试|
|供应商结束原因|`finish_reason=length`|JSON 在 2048 output tokens 上限处被截断|
|实际供应商 usage|2143 input + 2048 output tokens|来自原始响应；共 4191 tokens|
|保守账本|24636 input + 2048 output tokens，¥0.039394|失败调用保留调用前预算，不等同于最终供应商账单|
|完成照片|0/10|不能计算或宣称分类、冲突识别、拒判和同事件准确率|
|人物匹配|关闭|没有发起跨照片人脸身份匹配|

原始内容在一个字符串中间结束，无法构成完整 JSON。内容还把人物框写成了像素值，例如 `x=65`，而契约要求 0–1 归一化坐标；因此即使只增加长度，输出仍可能被 Schema 拒绝。

这轮结果支持两个工程结论：真实 endpoint、密钥与固定模型快照可用；失败停止、固定分母和 0 自动重试门禁有效。它不支持任何图片分类或归纳效果结论，也不支持“算法已达到产品可用”。

## 7. 已实施的适配修复

修复只针对本次观察到的工程失败，没有修改 10 例真值：

1. 把 `finish_reason=length` 显式记录为 `OUTPUT_TRUNCATED`，与普通 Schema 非法输出分开；
2. 为抽取和关联设置独立输出预算：探索清单采用 extract 4096、relate 1024；
3. 系统提示明确人物框必须使用 0–1 小数坐标，并限制人物描述和证据文字长度；
4. 离线 preflight 计算整批冷缓存输出预留量，并在超过总输出上限时提前提示；
5. 新增回归测试覆盖截断识别、分阶段预算和批次上限计算。

完整分类回归共 118 项通过，TypeScript typecheck 通过。这里证明的是工程修复通过本地门禁，仍然不能替代第二次真实响应验证。

## 8. 下一次真实调用 Gate

下一次调用应继续使用相同 10 例和固定模型，只验证适配修复是否使 10 张照片完成抽取与关联。不得改看过模型输出后的真值；不得自动重试；必须生成新的 manifest 哈希和单次授权。若再次出现截断、坐标非法或其他 Schema 错误，继续停止并记录，不进入保留集。

只有探索集可以完整评分后，才选择 2–3 个主要语义错误修复并冻结 Prompt、规则和阈值，然后进入未参与调参的保留集。没有独立保留集之前，只能称“真实 API 探索完成”，不能称算法达标。

## 9. 第二次真实调用结果

第二次结果目录：`/private/tmp/sgx-d4-qwen37-run-r2-20260924`。

这次模型正常结束，`finish_reason=stop`，模型版本仍与请求一致，说明上一轮的输出截断修复已经生效。但首张 C013 仍被严格契约拒收：顶层 JSON 除 `observations` 外额外回显了 `shapeGuide`；删除这个额外字段后，观察结果又因 `places=[]` 却没有把 `place` 写入 `unknownFacets` 而触发 `FACET_COVERAGE`。

|项目|结果|
|---|---:|
|真实请求|1 次|
|实际供应商 usage|2185 input + 1341 output tokens|
|保守账本|24636 input + 4096 output tokens，¥0.049224|
|累计保守记账|约 ¥0.088618|
|完成照片|0/10|
|自动重试|0 次|

因此第二轮仍然不能支持分类准确率、冲突识别或事件归纳效果结论。它支持的是：指定 endpoint、密钥、固定模型和较大抽取预算都能正常工作；严格 Schema 能拦住模型回显的非契约字段和漏写 unknown facet。

本地修复已实施：不再把 `shapeGuide` 放进可回显的用户 JSON，顶层字段和空 facet 规则改为系统约束，并增加对应回归测试。修复后分类回归仍为 118/118，TypeScript 检查通过。第三次付费调用必须重新获得明确授权；在此之前不自动调用。

## 10. 第三次 10 请求试验结果

第三轮结果目录：`/private/tmp/sgx-d4-qwen37-run-r3-10call-20260924`。

本轮按 10 次请求上限选择了 5 张图，计划为 5 次抽取和最多 5 次事件关联。实际第 1 次 C014 抽取即停止：模型正常结束（`finish_reason=stop`），但把一个照片拆成 `person`、`time`、`place`、`event`、`scene` 五个 observation，并额外输出了 `relations`；这违反了固定的 `ObservationSchema` 和抽取阶段只允许 `observations` 的规则。

|项目|结果|
|---|---:|
|真实请求|1 次|
|供应商模型|`qwen3.7-flash-2026-07-15`|
|实际 usage|1706 input + 874 output tokens|
|保守账本|24636 input + 4096 output tokens，¥0.049224|
|完成照片|0/5|
|事件关联|0 次|
|自动重试|0 次|

这轮仍然不能支持语义准确率，但确认了第三种 Prompt/输出形态不兼容。已实施的下一步本地修复是移除用户消息中的双层 `format` 示例，并在系统提示中明确“每张照片一个 observation、固定数组承载所有维度、抽取阶段禁止 relations”。本地修复后需重新授权才可以进行第四次真实调用。

## 11. 第四次真实调用结果

第四轮结果目录：`/private/tmp/sgx-d4-qwen37-run-r4-real-10call-20260924`。

这次确认密钥、真实 endpoint 和模型链路均已工作：供应商返回了真实 `chatcmpl-*` 响应，`finish_reason=stop`，实际响应 usage 为 1748 prompt tokens、785 completion tokens，延迟约 7.1 秒。严格校验仍拒收，但原因已经从“拆成多个 observation”变成了顶层键名错误：模型返回 `extract` 和 `relate`，而固定契约要求抽取阶段只允许 `observations`，关联阶段只允许 `relations`。同一张照片已经被正确放入一个 observation，五个 facet 数组和冲突记录也已生成。

|项目|结果|
|---|---:|
|真实请求|1 次|
|供应商模型|`qwen3.7-flash-2026-07-15`|
|供应商实际 usage|1748 input + 785 output tokens|
|保守账本|24636 input + 4096 output tokens，¥0.049224|
|完成照片|0/5（契约拒收）|
|事件关联|0 次|
|自动重试|0 次|

因此第四轮仍不能支持分类准确率结论，但它证明上一轮的“每张照片一个 observation”修复已经生效，并定位了新的顶层键偏差。下一步本地修复已写入系统提示和回归测试；再次真实调用需要新的明确授权，不能把本轮失败自动重试当作第五次调用。

## 12. 第五轮真实调用结果与系统排查

第五轮结果目录：`/private/tmp/sgx-d4-qwen37-run-r5-iterative-10call-20260925`。

这次顶层结构已经正确：模型返回了 `observations`，并且 C014 只生成了一个 observation。失败原因变成了字段级契约偏差：人物框使用了 `bbox` 数组而不是 `box` 对象；时间、地点、事件、场景分别使用了 `timeText`、`placeText`、`eventText`、`sceneText`，而契约要求 `value`、`label`、`type`；证据使用了 `evidence` 字符串而不是 `supports` 数组；`conflicts` 使用了对象数组而不是 facet 字符串数组；还输出了契约禁止的 `confidenceScore`。因此 Provider 在 Schema 阶段拒收，没有进入语义评分或后续照片。

|项目|结果|
|---|---:|
|真实请求|1 次|
|供应商模型|`qwen3.7-flash-2026-07-15`|
|供应商实际 usage|1789 input + 953 output tokens|
|保守账本|24636 input + 4096 output tokens，¥0.049224|
|完成照片|0/5（字段契约拒收）|
|事件关联|0 次|
|自动重试|0 次|

系统排查后已完成三项修复：把完整字段形状和禁止字段直接写入系统提示；加入空抽取对象示例；将 `PROMPT_VERSION` 更新为 `sgx-five-facets.2`，让提示变更自动使旧观察结果失效，避免缓存继续使用旧版本结果。修复后本地 `typecheck`、密钥扫描和 118 项分类回归均通过。

本轮证明的是 Prompt/契约兼容性仍在迭代，不是模型语义准确率。下一轮应验证字段级修复是否让真实响应进入 `validateObservation`；成功后才开始评价时间、地点、事件、场景和冲突标签。

## 13. 第六轮真实调用结果与根因收敛

第六轮结果目录：`/private/tmp/sgx-d4-qwen37-run-r6b-schema-v2-20260925`。此前一次 `APPROVAL_EXPIRED` 在发送请求前停止；随后更新授权的 r6b 发生了 1 次真实调用。再次执行同一个 r6b 命令出现的 `EEXIST` 是结果目录防覆盖，不是第二次模型失败，也没有新增 API 调用。

|项目|结果|
|---|---:|
|真实请求|1 次|
|供应商模型|`qwen3.7-flash-2026-07-15`|
|供应商响应 ID|已留存在受限权限的 `provider-responses.jsonl`，不写入版本库文档|
|供应商结束原因|`finish_reason=stop`|
|供应商实际 usage|2051 input + 1298 output tokens|
|保守账本|24636 input + 4096 output tokens，¥0.049224|
|完成照片|0/5（首张契约拒收后停止）|
|自动重试|0 次|

这次返回已经满足顶层键和单 observation 规则，人物框、supports、unknownFacets 等主要结构也正确。完整离线复盘找到三个问题：

1. `places[0]` 出现了非法键 `canonical?`。这是 Schema 阻断项，来源是 Prompt 用问号表达“可选”，模型把它当成了真实字段名。
2. `mentions` 放入视觉文字“生日快乐”。即使修掉第一个字段，它仍会被语义规则以 `MENTION_WITHOUT_TEXT` 拒收，因为 `mentions` 只承载用户文字中明确的人物名称或关系。
3. 用户文字明确说“不是生日”，视觉上却有生日装饰，模型仍返回 `conflicts=[]`。这是语义漏判，不是 JSON/Schema 问题。

已完成的本地修复包括：Prompt 升级到 `sgx-five-facets.3`；不用问号表示可选字段；明确 `mentions` 的来源边界和事件冲突规则；为 `INVALID_OUTPUT` 增加安全的字段路径诊断；结果目录重复时返回 `OUTPUT_DIRECTORY_EXISTS`；外层 CLI 不再为受控停止打印误导性的 Node 堆栈。

本轮仍没有形成可评分的分类效果。下一次真实调用必须使用新目录、新 manifest 哈希和未过期 approval；应先用 1 张 C014 做契约探针。若仍有字段漂移，不再继续逐字段付费试错，转入“视觉草稿 + 纯文本 JSON Schema 规范化”的双阶段设计，并把两个调用都纳入预算。

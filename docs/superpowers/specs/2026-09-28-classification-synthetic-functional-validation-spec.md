# 自动分类与归纳 T0/T1 合成功能验证 Spec

> 状态：Frozen
> 日期：2026-09-28
> 用户决策：合成但一致、清晰、可判定的数据可以作为当前 T0/T1 功能验证主数据；本阶段不要求证明家庭关系真实性或真实世界准确率。

## 1. 目标

用真实 Qwen/GLM 模型和高质量合成多模态数据，证明以下功能在多场景下能够完整、稳定、可追溯地执行：

- 图片、用户文字和 final ASR 的七类输入组合；
- 人物、时间、地点、事件、场景和主题的分类；
- 同事件分组、不同事件隔离、近重复和跨批次归纳；
- AI 标题、摘要、筛选标签和 Evidence 解释；
- 冲突、拒判、高风险确认和低风险自动整理；
- 用户确认、拒绝、拆分、合并、移出、删除和撤权；
- 增量输入、未变化内容复用、迟到结果拒收；
- 请求、Token、费用、延迟和失败恢复。

## 2. 结论边界

本阶段通过后可以声称：

> 自动分类与归纳功能在冻结的合成多模态场景中通过 T0 离线功能验证和 T1 本地产品 Alpha 验收。

本阶段不能声称：

- 虚构人物关系对应真实关系；
- 真实家庭准确率或跨家庭泛化；
- 真实老人 ASR、真实手机相册或长期人物识别效果；
- 生产数据库、队列、对象存储或生产部署完成。

## 3. 数据设计

### 3.1 语义固定分母

- 继续使用现有 40 个内容组；
- exploration 26 组，validation 14 组；
- 原 v3 目录永久只读；
- 新冻结版本为 v3.1；
- v3.1 复用已验收媒体，但必须独立复核新的 grouping、binding 和 truth；
- validation 开始后不得修改模型、Prompt、taxonomy、规则、truth 或评分器。

### 3.2 功能诊断运行

另建 12 个 diagnostic runs，不计入 40 组语义准确率分母：

- 4 个 5–10 图批次；
- 4 个跨批次故事序列，每个序列分两次输入，共 8 个运行；
- 覆盖同故事增量、近重复、同人物不同事件、批次级文字、跨家庭隔离和部分失败；
- 只能复用同一 partition 的媒体；
- 报告必须把 `semanticDenominator=40` 与 `diagnosticRuns=12` 分开。

只有跨几十年人物变化、严重遮挡或长期多人交叉等人物压力测试需要新图，不阻塞当前 T0/T1。

## 4. v3.1 真值原则

1. 真值中的每个 required assertion 必须有模型实际可见的图片、用户文字、final ASR、可信 EXIF 或固定 reference time 支持。
2. 系统知道但模型看不到的上传时间、来源说明或旧 truth 不进入模型语义分母。
3. 冲突必须结构化记录来源和值；非故意冲突必须修正。
4. `abstain/no_assertion` 是维度级结果，不等同于整组不整理；可识别 scene 时允许 partial organize。
5. 人物至少区分可见匿名人物、用户明确 mention/关系和跨图候选；不得把 `subjectId` 当成可见人物身份。
6. 用户明确关系可以作为 fixture truth；模型无需证明其现实真实性，但不得从画面自行发明姓名或关系。
7. audio original 只作 ASR provenance，不直接进入分类器；只有 final ASR 进入 Evidence。
8. 同一 lineage、近重复或跨批次故事不得跨 exploration/validation。
9. 原 v3 的失败记录和 digest 保留；v3.1 使用新目录、新 digest 和独立 acceptance。

## 5. 已知必须修正的 v3 问题

- `g011/g012/g021/g025/g029` 的时间冲突没有进入 `conflicts`；`g018` 还有事件冲突，`g019` 应改为否定语义而非冲突。
- `g007/g009/g010/g030` 混入模型不可见或未提供 reference time 的 upload/scan 绝对时间。
- `g008/g029` 若评分精确日期，必须显式加入可信 EXIF；否则删除精确日期真值。
- `g013/g014/g034` 的文字/ASR binding 过宽，需改为实际单图或批次范围。
- `g016` 撤回素材必须转换为 tombstone，不得继续作为 active Evidence。
- `g032` 的 1999 年没有模型可见证据，必须从语义真值移除。
- `g036/g037` 的 prompt/metadata injection 输入与 forbidden assertion 必须完整保留。
- 全部 group-local synthetic identity 需要映射为稳定的虚构 household/subject/person namespace。

逐组修正以 v3.1 review ledger 为唯一依据。

## 6. 可执行路由

每个 v3.1 group 先转换为 `classification-ingestion.2`，再按能力路由：

```text
有 active image + 单图显式文字/ASR
  → Stage A photo-anchored real/fake provider

纯文字、纯 final ASR、批次级或多图说明
  → Content Organization text path

withdrawn/deleted
  → tombstone/lifecycle path，不调用模型

diagnostic sequence
  → 同一 scope 的完整 active catalog + tombstone 增量运行
```

转换器必须验证：路径 containment、普通文件、字节数、SHA-256、MIME、scope、binding、lifecycle、partition 和 synthetic provenance。合成素材不得写成 `real_user_provided`。

## 7. T0 Gate

### 7.1 工程硬门禁

以下必须 100% 通过：

- Schema、hash、路径和 Evidence 引用；
- scope、家庭、主体和授权隔离；
- conflict/high-risk 不被静默自动合并；
- withdrawal/delete/late result 不进入有效结果；
- Mock 40 组 + 12 diagnostic runs 无网络执行完成；
- validation 运行期间版本和 truth 不变化。

### 7.2 合成功能门禁

- validation 场景通过至少 12/14；未来扩成 20 组时对应至少 18/20；
- conflict、高风险、撤权、跨 scope、不同事件防误合并全部通过；
- false merge = 0；
- 标题摘要无依据事实 = 0；
- action/risk 路由、binding、storyKey 和 diagnostic sequence 单独报告；
- 普通非关键标签遗漏进入失败台账，不以自动重试隐藏。

这些数字只表示冻结合成测试集上的功能结果，不是概率或真实准确率。

## 8. T1 Gate

- `/classification-lab` 使用同一真实 Provider adapter，密钥仅在服务端；
- 七类输入从页面均可提交；
- 标签、StoryUnit、标题、摘要、Evidence、风险、用量和时延可见；
- 接受、拒绝、拆分、合并、移出、删除和撤权可运行；
- 重复提交幂等、旧版本操作拒绝、失败不覆盖 last-known-good；
- 10 图批次完成；20 图批次至少做一次压力诊断；
- 删除或撤权后受保护素材读取次数为 0。

## 9. 真实模型实验顺序

1. 冻结 v3.1、adapter 和 Mock 报告；
2. 固定 Qwen/GLM、Prompt、模型快照、taxonomy、批次 digest、请求/Token/费用/时间上限和 0 自动重试；
3. 先做 1 个契约探针；
4. exploration 记录所有语义错误，不因普通漏标签停止；
5. 只根据 exploration 修复；
6. 冻结全部版本；
7. validation 一次性运行；
8. validation 结果不得回流调参；
9. 把同一 Provider 接入 T1 页面并进行人工验收。

遇到非法 Schema、无效 Evidence、scope/digest 不一致、高风险自动合并、false merge、撤权后继续使用、预算超限或任何自动重试时，立即停止当前批次并保留证据。

## 10. 本轮完成标准

- 用户决策和 claim boundary 已冻结；
- v3.1 可重复生成，原 v3 不被覆盖；
- 40 组 corrected truth 和独立 review ledger 完成；
- 12 diagnostic runs 完成；
- synthetic adapter 有自动化测试；
- Mock 全量报告完成；
- 真实模型 exploration 的准确批次、digest 和预算可供最终批准。

# Classification Stage A 可信输入适配 Spec

> 状态：Frozen for I01 implementation  
> 日期：2026-09-23  
> 适用范围：自动分类 Stage A 的业务 Evidence 到算法输入边界

> 2026-09-27 范围补充：本 Spec 冻结的是现有“图片及其单图绑定文字/final ASR”适配器，不是最终产品输入契约。产品现已确认支持纯文本、纯 final ASR、多图片共用说明和家庭双端互传组合；这些能力必须由下一版多内容输入契约表达，不能继续用单图绑定规则代替。

## 1. 本轮目标

实现一个仅在可信后端运行的纯适配器，把已完成鉴权、内容读取和完整性校验的 Evidence 目录转换为：

- Stage A `Request`；
- 与该请求完全对应的 `AuthorizationSnapshot`；
- 只允许读取本次授权图片的 `ImageResolver`；
- 可审计的 `actorId / subjectId / ownerId / contributorId / sourceRef / consentRef` 映射。

完成后，全栈工程师可以用 Fake/Mock 链路验证业务层与 Stage A 的数据边界。它不代表真实视觉模型准确率，不新增数据库、Redis、队列、产品 API 或 UI，也不调用真实模型。

## 2. 为什么不能直接转换 `ContentBundle`

`ContentBundle` 中的 `EvidenceRecord` 只保存元数据和受保护的 `sourceRef`，没有图片字节、用户文字正文或最终 ASR 正文。单个 Bundle 也不一定等于某个老人当前已授权的完整照片目录。因此客户端提交的 Bundle 不能直接成为 Stage A 请求。

后端必须先完成两步：

1. 依据当前操作者、主体、家庭、授权版本和证据生命周期，解析出完整的可信 Evidence 目录；
2. 读取受保护内容，校验字节数与 SHA-256，并明确每条文字/ASR 属于哪张照片，再调用本适配器。

客户端不得构造这里定义的内部对象。适配器不承担登录鉴权、对象存储下载或数据库查询。

## 3. 身份和来源规则

- `actorId`：当前触发本次分类的人或服务身份；不得从历史上传者推断。
- `subjectId`：照片进入哪位老人的生命记忆空间，也是 Stage A scope 的主体。
- `ownerId`：原始素材权利主体。
- `contributorId`：上传或补充该条 Evidence 的人。
- 上传者、素材所有者和照片中的人物都不能自动等同于 `subjectId`。
- 图片、用户文字和最终 ASR 必须保留独立 `evidenceId`、来源哈希、修订号和授权信息。
- 原始音频和 partial ASR 不进入 Stage A；只有 `asr.final=true` 的 transcript 可进入。

## 4. 可信输入

适配器接收一个 `TrustedStageACatalog`：

```ts
interface TrustedStageACatalog {
  actorId: string;
  scope: { householdId: string; subjectId: string };
  authorizationRevision: string;
  contextRevision: string;
  authorityRef: string;
  allowPersonMatching: boolean;
  allowedEvidenceIds: string[];
  allowedConsentRefs: string[];
  evidence: EvidenceRecord[]; // 完整目录，包含 active 图片、文字/ASR 和删除墓碑
  photos: TrustedPhotoEvidence[];
  references: Reference[];
  corrections: Correction[];
}

interface TrustedPhotoEvidence {
  image: ActiveImageEvidence | DeletedImageTombstone;
  imageBytes?: Uint8Array;
  textEvidence: Array<{
    record: ActiveTextEvidence | ActiveFinalTranscriptEvidence;
    text: string;
  }>;
  priorPhoto?: Photo;
}
```

约束：

- `photos` 是当前 scope 的完整照片目录，不允许用“本次只上传的一张图”冒充完整目录。
- active 图片必须包含图片字节；deleted tombstone 必须包含同 ID 的 `priorPhoto`，用于生成 `active=false` 的撤回项。
- 每条 active 文字/ASR 必须显式绑定到一张 active 图片；不自动绑定到全部图片，也不静默丢弃。
- `allowedEvidenceIds` 同时覆盖图片及绑定的文字/ASR；`allowedConsentRefs` 覆盖所有 active Evidence。
- 所有 Evidence 必须与 catalog scope 一致。
- `sourceHash` 按原始字节计算；文字按 UTF-8 字节计算。

## 5. Stage A 输入扩展

`Photo` 增加 `textEvidence`：

```ts
interface PhotoTextEvidence {
  evidenceId: string;
  revision: number;
  sourceHash: `sha256:${string}`;
  source: 'user_text' | 'final_asr';
  text: string;
}
```

现有 `caption` 暂时保留，只用于兼容已有 Stage A fixture；可信适配器生成的新请求固定写入空 `caption`，不会把多个来源合并。模型输出的 support 可使用 `user_text` 或 `final_asr`，且必须带 `evidenceId` 并逐字引用对应正文。`photoHash` 覆盖完整 `Photo`，因此任一独立文字的添加、修改或撤回都会使该照片重新抽取。

图片的受保护 `sourceRef` 不发送给模型。Stage A 内部 `photoId/sourceRef` 使用图片 `evidenceId`；原始 `SourceRef` 只保存在适配器 audit 映射和后端解析层。

## 6. 输出和责任边界

适配器返回：

```ts
interface AdaptedStageAInput {
  request: Request;
  authorization: AuthorizationSnapshot;
  resolveImage: ImageResolver;
  audit: {
    actorId: string;
    authorityRef: string;
    evidence: EvidenceAuditEntry[];
  };
}
```

适配器只做确定性转换和拒绝，不写业务数据库、不创建长期 Memory、不确认算法候选。Stage A 的 observation、group 和 relation 仍是可复核候选；后续 Assertion/Memory 写入必须经过独立业务流程与用户确认规则。

## 7. 必须拒绝的输入

| 错误码 | 条件 |
|---|---|
| `INCOMPLETE_EVIDENCE_CATALOG` | active 图片集合与授权目录不一致 |
| `MISSING_EVIDENCE_PAYLOAD` | active 图片或文字没有正文 |
| `SOURCE_HASH_MISMATCH` | 图片或 UTF-8 文字哈希不匹配 |
| `SOURCE_LENGTH_MISMATCH` | 内容字节数与 Evidence 元数据不一致 |
| `UNBOUND_TEXT_EVIDENCE` | 授权目录包含文字/ASR，但未绑定到任何图片 |
| `DUPLICATE_EVIDENCE_BINDING` | 同一文字/ASR 被绑定到多张图片 |
| `CROSS_SCOPE` | Evidence 的家庭或主体不一致 |
| `NOT_AUTHORIZED` | Evidence ID、consent 或 authority 不在当前授权快照中 |
| `INACTIVE_EVIDENCE` | trashed/deletion_pending 内容仍被当作 active 输入 |
| `DELETION_REQUIRES_PRIOR_PHOTO` | 删除墓碑缺少上一版 Photo |

## 8. 验收测试

实现至少覆盖：

1. 一张图片 + 用户文字 + 最终 ASR 能转换，三种来源保持独立；
2. 模型对 `user_text/final_asr` 的引用只能命中对应 Evidence 正文；
3. `actorId/subjectId/ownerId/contributorId` 不混淆，audit 可追溯；
4. 跨家庭、跨主体、未授权 ID/consent 被拒绝；
5. 缺失内容、字节长度错误、哈希错误被拒绝；
6. 未绑定或重复绑定文字被拒绝；
7. partial ASR 无法通过既有 Evidence schema；
8. 删除墓碑生成 inactive Photo，缺少 prior snapshot 时拒绝；
9. resolver 只能读取当前授权且哈希一致的 active 图片；
10. 适配后的请求能通过 `RequestSchema` 并进入 Fake/Mock Stage A 链路。

## 9. 提交与停止条件

本轮拆为三个可回退提交：

1. 冻结本 Spec；
2. 扩展 Stage A 来源契约，实现适配器与聚焦测试；
3. 更新全栈交接、验证记录和当前状态。

完成条件是 `npm run test:classification`、`npm run typecheck` 和分类密钥扫描通过，且 git diff 不包含未跟踪的历史项目或生产配置。完成后停止在 Fake/Mock 集成边界；新版图片未正式交付、真值未冻结和真实调用未再次授权前，不启动 D4 或真实 API。

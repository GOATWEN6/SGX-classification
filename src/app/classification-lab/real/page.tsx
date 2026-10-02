'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from '../classification-lab.module.css';

type SmokeStatus = {
  model: string;
  promptVersion: string;
  maxRequests: number;
  usedRequests: number;
  remainingRequests: number;
  maxCostCny: number;
  usedCostCny: number;
  expiresAt: string;
};

type Observation = {
  contentId: string;
  facet: string;
  rawValue: string;
  normalizedValue?: string;
  state: string;
  supports: Array<{ evidenceId: string; sourceType?: string; quote?: string }>;
};

type SmokeResult = {
  runId: string;
  workflowStatus: 'succeeded' | 'needs_review';
  provider: { providerVersion: string; modelVersion: string; promptVersion: string };
  organization: {
    stories: Array<{
      storyId: string;
      state: string;
      titleCandidate: string;
      summaryCandidate: string;
      memberContentIds: string[];
      facets: { people: string[]; times: string[]; places: string[]; themes: string[] };
      titleSupports: string[];
      summarySupports: string[];
    }>;
    associations: Array<{
      associationId: string;
      relation: string;
      source: string;
      status: string;
      decisionBasis?: string;
      evidenceStrength?: string;
    }>;
    reviewItems: string[];
  };
  observations: Observation[];
  reviewItems: string[];
  unresolvedTemporalObservations: Array<{ rawValue: string; role: string; reason: string }>;
  usage: { requests: number; images: number; inputTokens: number; outputTokens: number; costCny: number; latencyMs: number };
};

const errorCopy: Record<string, string> = {
  CLASSIFICATION_LAB_DISABLED: '真实模型实验台尚未启动。',
  MODEL_NOT_CONFIGURED: '服务端没有加载模型密钥。',
  REAL_SMOKE_ONE_IMAGE_REQUIRED: '首轮 T0 每次只测试 1 张照片。',
  REAL_SMOKE_IMAGE_TOO_LARGE: '图片超过 1 MiB，请先压缩后再试。',
  REAL_SMOKE_REQUEST_LIMIT: '本轮已达到授权的调用次数上限。',
  REAL_SMOKE_COST_LIMIT: '本轮已达到授权的费用上限。',
  REAL_SMOKE_APPROVAL_EXPIRED: '本轮真实调用授权已到期。',
  REAL_SMOKE_APPROVAL_CHANGED: '本轮授权参数与已有记账文件不一致，请检查启动配置。',
  REAL_SMOKE_CONFIG_INVALID: '真实模型实验台启动参数不完整或格式错误。',
  REAL_SMOKE_DISABLED: '真实模型实验台未启用。',
  INVALID_OUTPUT: '模型返回格式不符合契约，已停止且不会自动重试。',
  OUTPUT_TRUNCATED: '模型输出被截断，已停止且不会自动重试。',
  RATE_LIMITED: '模型服务限流，已停止且不会自动重试。',
  PROVIDER_UNAVAILABLE: '模型服务暂时不可用，已停止且不会自动重试。'
};

function facetName(value: string): string {
  return ({ person: '人物', time: '时间', place: '地点', event: '事件', scene: '场景', theme: '主题', content_type: '内容类型' } as Record<string, string>)[value] ?? value;
}

export default function ClassificationRealSmokePage() {
  const [status, setStatus] = useState<SmokeStatus>();
  const [file, setFile] = useState<File>();
  const [userText, setUserText] = useState('');
  const [finalAsr, setFinalAsr] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SmokeResult>();
  const preview = useMemo(() => file ? URL.createObjectURL(file) : '', [file]);

  useEffect(() => () => { if(preview) URL.revokeObjectURL(preview); }, [preview]);

  const refresh = async () => {
    try {
      const response = await fetch('/api/classification-lab/real-smoke', { cache: 'no-store' });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'REAL_SMOKE_STATUS_FAILED');
      setStatus(body.status);
    } catch(value) {
      const code = value instanceof Error ? value.message : 'REAL_SMOKE_STATUS_FAILED';
      setError(errorCopy[code] ?? `实验台不可用：${code}`);
    }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if(!file) return;
    setLoading(true);
    setError('');
    setResult(undefined);
    try {
      const form = new FormData();
      form.append('images', file);
      form.append('metadata', JSON.stringify({
        scope: { householdId: 'house_local_t0', subjectId: 'elder_local_t0' },
        actorId: 'tester_local_t0',
        contextKind: 'album_upload',
        recipientIds: [],
        ...(userText.trim() ? { userText: userText.trim(), userTextTargetIndexes: [0] } : {}),
        ...(finalAsr.trim() ? { finalAsr: finalAsr.trim(), finalAsrTargetIndexes: [0] } : {}),
        submittedAt: new Date().toISOString()
      }));
      const response = await fetch('/api/classification-lab/real-smoke', {
        method: 'POST',
        headers: { 'x-sgx-classification-lab': '1' },
        body: form
      });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'REAL_SMOKE_FAILED');
      setResult(body.result);
      setStatus(body.status);
    } catch(value) {
      const code = value instanceof Error ? value.message : 'REAL_SMOKE_FAILED';
      setError(errorCopy[code] ?? `真实模型测试失败：${code}`);
      await refresh();
    } finally { setLoading(false); }
  };

  return <main className={styles.page}>
    <header className={styles.hero}>
      <div>
        <p className={styles.eyebrow}>SGX · T0 真实模型冒烟</p>
        <h1>真实照片分类与归纳</h1>
        <p>上传 1 张照片，可补充文字或最终 ASR。服务端会真实调用 Qwen，返回五维标签、标题、摘要和证据。</p>
      </div>
      <div className={styles.modeCard}>
        <strong>真实 API · 受控额度</strong>
        <span>{status ? `${status.remainingRequests}/${status.maxRequests} 次剩余` : '读取中'}</span>
        <small>{status ? `已记账 ¥${status.usedCostCny.toFixed(4)} / ¥${status.maxCostCny.toFixed(2)}` : '0 自动重试 · 单图冒烟'}</small>
      </div>
    </header>

    {error && <div className={styles.error} role="alert">{error}</div>}

    <section className={styles.workspace}>
      <form className={styles.formPanel} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className={styles.sectionHeading}><div><span>01</span><h2>上传测试输入</h2></div><small>1 张 · 最大 1 MiB</small></div>
        <label className={styles.dropzone}>
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setFile(event.target.files?.[0])} />
          <strong>{file ? file.name : '点击选择真实照片'}</strong>
          <span>{file ? `${(file.size / 1024).toFixed(1)} KiB` : 'JPEG、PNG 或 WebP；照片仅发送给本轮已授权模型'}</span>
        </label>
        {file && <div className={styles.fileGrid}><article className={styles.fileCard}><img src={preview} alt="待测试照片预览" /><div><strong>{file.name}</strong><small>本次只分析这一张</small></div></article></div>}
        <p className={styles.help}>文字和 ASR 会作为这张照片的用户证据。人物姓名、亲属关系和长期 Memory 不会自动确认。</p>
        <div className={styles.textGrid}>
          <label>用户文字说明<textarea value={userText} onChange={event => setUserText(event.target.value)} rows={4} placeholder="例如：这是1985年在武汉拍的大学毕业照" /></label>
          <label>最终 ASR 文本<textarea value={finalAsr} onChange={event => setFinalAsr(event.target.value)} rows={4} placeholder="可粘贴语音识别后的最终文字" /></label>
        </div>
        <button className={styles.submit} disabled={!file || loading || status?.remainingRequests === 0}>
          {loading ? '真实模型正在识别，通常需数秒…' : '调用真实模型开始测试'}
        </button>
      </form>

      <aside className={styles.historyPanel}>
        <div className={styles.sectionHeading}><div><span>02</span><h2>本轮边界</h2></div></div>
        <div className={styles.row}><span>模型</span><strong>{status?.model ?? '—'}</strong></div>
        <div className={styles.row}><span>Prompt</span><strong>{status?.promptVersion ?? '—'}</strong></div>
        <div className={styles.row}><span>自动重试</span><strong>0</strong></div>
        <div className={styles.row}><span>人物候选</span><strong>本页单图不做跨图匹配</strong></div>
        <div className={styles.row}><span>阶段</span><strong>T0 可行性</strong></div>
        <p className={styles.help}>正式多图批次会在逐图授权并绑定 person consent 后开启匿名人物候选；姓名和亲属关系仍需用户确认。本页结果只验证单图真实模型链路，不代表真实家庭场景准确率已经达标。</p>
      </aside>
    </section>

    {result && <section className={styles.results}>
      <div className={styles.resultHeader}>
        <div><p className={styles.eyebrow}>运行 {result.runId}</p><h2>{result.workflowStatus === 'succeeded' ? '识别完成' : '完成，包含待复核项'}</h2></div>
        <div className={styles.metrics}>
          <span><strong>{result.usage.requests}</strong>真实请求</span>
          <span><strong>{result.usage.inputTokens + result.usage.outputTokens}</strong>Token</span>
          <span><strong>¥{result.usage.costCny.toFixed(4)}</strong>记账费用</span>
          <span><strong>{(result.usage.latencyMs / 1000).toFixed(1)} 秒</strong>模型耗时</span>
        </div>
      </div>
      <div className={styles.notice}><strong>AI 整理：</strong>标题与摘要是候选结果；用户原文仍独立保留。复核项不会自动写入长期 Memory。</div>
      <div className={styles.storyGrid}>
        {result.organization.stories.map(story => <article className={styles.storyCard} key={story.storyId}>
          <div className={styles.storyTop}><div><span className={styles.state}>AI 整理</span><h3>{story.titleCandidate}</h3></div><small>{story.memberContentIds.length} 项内容</small></div>
          <p>{story.summaryCandidate}</p>
          <div className={styles.chips}>{[...story.facets.people, ...story.facets.times, ...story.facets.places, ...story.facets.themes].map(value => <span key={value}>{value}</span>)}</div>
        </article>)}
      </div>
      <div className={styles.detailGrid}>
        <section className={styles.detailCard}><h3>模型识别标签</h3>
          {result.observations.map((item, index) => <div className={styles.row} key={`${item.contentId}-${item.facet}-${index}`}><span>{facetName(item.facet)}</span><strong>{item.normalizedValue ?? item.rawValue}</strong></div>)}
        </section>
        <section className={styles.detailCard}><h3>自动归纳决策</h3>
          {result.organization.associations.length === 0
            ? <p className={styles.empty}>本次没有跨内容关系需要判断。</p>
            : result.organization.associations.map(item => <div className={styles.row} key={item.associationId}><div><strong>{item.relation}</strong><small>{item.source} · {item.status}</small></div><span>{item.source === 'user_explicit' ? '用户明确指定' : `${item.decisionBasis ?? 'retrieval_only'} · ${item.evidenceStrength ?? 'insufficient'}`}</span></div>)}
        </section>
        <section className={styles.detailCard}><h3>需处理与暂存信息</h3>
          {result.reviewItems.length === 0
            ? <p className={styles.empty}>没有需要用户处理的项目。</p>
            : result.reviewItems.map(item => <p className={styles.risk} key={item}>{item}</p>)}
          {result.unresolvedTemporalObservations.map((item, index) => <p className={styles.help} key={`${item.rawValue}-${index}`}>时间“{item.rawValue}”暂未用于时间线：{item.reason}</p>)}
        </section>
        <section className={styles.detailCard}><h3>运行证据</h3>
          <div className={styles.row}><span>模型</span><strong>{result.provider.modelVersion}</strong></div>
          <div className={styles.row}><span>Prompt</span><strong>{result.provider.promptVersion}</strong></div>
          <div className={styles.row}><span>输入 Token</span><strong>{result.usage.inputTokens}</strong></div>
          <div className={styles.row}><span>输出 Token</span><strong>{result.usage.outputTokens}</strong></div>
        </section>
      </div>
    </section>}
  </main>;
}

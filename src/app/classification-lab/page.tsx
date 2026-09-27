'use client';

/* eslint-disable @next/next/no-img-element -- local object URLs and guarded lab asset routes are intentionally rendered without the production image optimizer. */

import { useEffect, useMemo, useState } from 'react';
import styles from './classification-lab.module.css';

type Evidence = {
  evidenceId: string;
  modality?: 'image' | 'text' | 'transcript';
  lifecycleState: string;
  sourceHash?: string;
  consentRef?: string;
  mimeType?: string;
};
type Content = { contentId: string; evidenceId: string; modality: 'image' | 'user_text' | 'final_asr'; lifecycleState: string };
type Story = {
  storyId: string;
  titleCandidate: string;
  summaryCandidate: string;
  memberContentIds: string[];
  facets: { people: string[]; times: string[]; places: string[]; themes: string[] };
  titleSupports: string[];
  summarySupports: string[];
  state: string;
};
type Association = {
  associationId: string;
  fromContentId: string;
  toContentId?: string;
  relation: string;
  source: string;
  status: string;
  score?: number;
  evidenceRefs: string[];
};
type LabJob = {
  jobId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  scope: { householdId: string; subjectId: string };
  envelope: { context: { kind: string }; evidence: Evidence[]; contents: Content[] };
  originalTextByEvidenceId: Record<string, string>;
  result?: {
    provider: { mode: string; providerVersion: string; modelVersion: string; evidenceStatus: string; accuracyClaim: string };
    organization: { stories: Story[]; associations: Association[]; reviewItems: string[]; retrievalAudit: { candidateCount: number; evaluatedCount: number; policyMode: string } };
    observations: Array<{ contentId: string; evidenceId: string; facet: string; rawValue: string; state: string; supports: Array<{ evidenceId: string; quote?: string }> }>;
    batchBindings: Array<{ bindingId: string; sourceContentId: string; state: string }>;
    retrieval: { candidateCount: number; comparisonCount: number; scoreMeaning: string };
  };
  metrics?: { latencyMs: number; modelRequests: number; costCny: number };
  error?: { code: string };
};
type Capabilities = {
  enabled: boolean;
  providerMode: string;
  providerEvidence: string;
  accuracyClaim: string;
  realProviderConfigured: boolean;
  persistence: string;
};

const errorCopy: Record<string, string> = {
  CLASSIFICATION_LAB_DISABLED: '实验台尚未启用。请按页面底部命令重新启动本地开发服务。',
  CLASSIFICATION_LAB_LOOPBACK_ONLY: '实验台只允许从本机 localhost 打开。',
  MIME_SIGNATURE_OR_DIMENSIONS_MISMATCH: '有图片的真实格式与文件声明不一致，或无法读取尺寸。',
  IMAGE_SIZE_LIMIT: '单张图片超过 20 MiB。',
  IMAGE_PIXEL_LIMIT: '单张图片超过 4000 万像素。',
  TOO_MANY_IMAGES: '一次最多上传 20 张图片。',
  EMPTY_SUBMISSION: '请至少添加图片、用户说明或最终 ASR 文字之一。',
  REAL_PROVIDER_ADAPTER_NOT_CONFIGURED: '真实模型适配器尚未配置，本阶段只能使用本地确定性基线。'
};

function shortHash(value?: string) { return value ? `${value.slice(0, 15)}…${value.slice(-6)}` : '—'; }
function statusCopy(status: string) {
  return ({ pending: '等待处理', processing: '正在整理', succeeded: '整理完成', needs_review: '需要确认', failed: '处理失败', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
}
function storyStateCopy(state: string) {
  return ({ ai_candidate: 'AI 整理候选', needs_review: '待确认', user_confirmed: '用户已确认', withdrawn: '已撤回' } as Record<string, string>)[state] ?? state;
}
function modalityCopy(modality: string) { return ({ image: '图片', user_text: '用户原文', final_asr: '最终 ASR' } as Record<string, string>)[modality] ?? modality; }

export default function ClassificationLabPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [userText, setUserText] = useState('');
  const [finalAsr, setFinalAsr] = useState('');
  const [userTargets, setUserTargets] = useState<number[]>([]);
  const [asrTargets, setAsrTargets] = useState<number[]>([]);
  const [contextKind, setContextKind] = useState<'album_upload' | 'family_transfer'>('album_upload');
  const [householdId, setHouseholdId] = useState('local_household');
  const [subjectId, setSubjectId] = useState('local_elder');
  const [actorId, setActorId] = useState('local_elder');
  const [senderId, setSenderId] = useState('local_child');
  const [recipientIds, setRecipientIds] = useState('local_elder');
  const [job, setJob] = useState<LabJob | null>(null);
  const [history, setHistory] = useState<LabJob[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const urls = files.map(file => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [files]);

  const fetchHistory = async () => {
    try {
      const response = await fetch('/api/classification-lab', { cache: 'no-store' });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'LAB_REQUEST_FAILED');
      setCapabilities(body.capabilities);
      setHistory(body.jobs ?? []);
      if(!job && body.jobs?.length) setJob(body.jobs[0]);
    } catch(value) {
      const code = value instanceof Error ? value.message : 'LAB_REQUEST_FAILED';
      setError(errorCopy[code] ?? `实验台暂不可用：${code}`);
    }
  };

  useEffect(() => { void fetchHistory(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTarget = (index: number, current: number[], setCurrent: (next: number[]) => void) => {
    setCurrent(current.includes(index) ? current.filter(value => value !== index) : [...current, index].sort((a, b) => a - b));
  };

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const form = new FormData();
      files.forEach(file => form.append('images', file));
      form.append('metadata', JSON.stringify({
        scope: { householdId, subjectId }, actorId,
        contextKind,
        ...(contextKind === 'family_transfer' ? { senderId, recipientIds: recipientIds.split(/[，,\s]+/).map(value => value.trim()).filter(Boolean) } : { recipientIds: [] }),
        ...(userText.trim() ? { userText: userText.trim() } : {}),
        ...(finalAsr.trim() ? { finalAsr: finalAsr.trim() } : {}),
        userTextTargetIndexes: userText.trim() && userTargets.length ? userTargets : null,
        finalAsrTargetIndexes: finalAsr.trim() && asrTargets.length ? asrTargets : null,
        submittedAt: new Date().toISOString()
      }));
      const response = await fetch('/api/classification-lab', { method: 'POST', headers: { 'x-sgx-classification-lab': '1' }, body: form });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'LAB_REQUEST_FAILED');
      setCapabilities(body.capabilities);
      setJob(body.job);
      await fetchHistory();
    } catch(value) {
      const code = value instanceof Error ? value.message : 'LAB_REQUEST_FAILED';
      setError(errorCopy[code] ?? `处理失败：${code}`);
    } finally { setLoading(false); }
  };

  const contentById = useMemo(() => new Map(job?.envelope.contents.map(content => [content.contentId, content]) ?? []), [job]);
  const evidenceById = useMemo(() => new Map(job?.envelope.evidence.map(evidence => [evidence.evidenceId, evidence]) ?? []), [job]);
  const observationByContent = useMemo(() => {
    const map = new Map<string, NonNullable<LabJob['result']>['observations']>();
    for(const observation of job?.result?.observations ?? []) map.set(observation.contentId, [...(map.get(observation.contentId) ?? []), observation]);
    return map;
  }, [job]);

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>SGX · T1 本地产品 Alpha</p>
          <h1>图文分类实验台</h1>
          <p>上传真实图片，并补充用户原文或最终 ASR。页面真实走服务端 Evidence、抽取、稀疏召回和故事组织链。</p>
        </div>
        <div className={styles.modeCard}>
          <strong>当前运行模式</strong>
          <span>{capabilities?.providerMode === 'deterministic' ? '本地确定性基线' : capabilities?.providerMode ?? '等待连接'}</span>
          <small>非模型准确率 · 不调用付费 API · 人物身份不匹配</small>
        </div>
      </header>

      {error && <div className={styles.error} role="alert">{error}</div>}

      <section className={styles.workspace}>
        <form className={styles.formPanel} onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div className={styles.sectionHeading}>
            <div><span>01</span><h2>准备输入</h2></div>
            <small>最多 20 张，每张 20 MiB</small>
          </div>
          <label className={styles.dropzone}>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event => {
              const next = Array.from(event.target.files ?? []).slice(0, 20);
              setFiles(next); setUserTargets([]); setAsrTargets([]);
            }} />
            <strong>{files.length ? `已选择 ${files.length} 张图片` : '点击选择照片'}</strong>
            <span>支持 JPEG、PNG、WebP；服务端会重验真实格式和尺寸</span>
          </label>

          {files.length > 0 && <div className={styles.fileGrid}>
            {files.map((file, index) => <article key={`${file.name}-${file.lastModified}`} className={styles.fileCard}>
              <img src={previews[index]} alt={file.name} />
              <div><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(1)} KiB</small></div>
              <label><input type="checkbox" checked={userTargets.includes(index)} disabled={!userText.trim()} onChange={() => toggleTarget(index, userTargets, setUserTargets)} />说明关联</label>
              <label><input type="checkbox" checked={asrTargets.includes(index)} disabled={!finalAsr.trim()} onChange={() => toggleTarget(index, asrTargets, setAsrTargets)} />ASR 关联</label>
            </article>)}
          </div>}
          <p className={styles.help}>不勾选图片时，文字按“本批次说明”保存；勾选一张或多张时，保留用户明确关联。</p>

          <div className={styles.textGrid}>
            <label>用户原文<textarea value={userText} onChange={event => setUserText(event.target.value)} placeholder="例如：这是1985年在武汉的大学同学聚会" rows={4} /></label>
            <label>最终 ASR<textarea value={finalAsr} onChange={event => setFinalAsr(event.target.value)} placeholder="粘贴已经完成识别的最终转写，不填实时中间结果" rows={4} /></label>
          </div>

          <div className={styles.sectionHeading}><div><span>02</span><h2>产品场景</h2></div></div>
          <div className={styles.segmented}>
            <button type="button" className={contextKind === 'album_upload' ? styles.selected : ''} onClick={() => setContextKind('album_upload')}>上传到智能相册</button>
            <button type="button" className={contextKind === 'family_transfer' ? styles.selected : ''} onClick={() => setContextKind('family_transfer')}>家庭双端互传</button>
          </div>
          <div className={styles.fieldGrid}>
            <label>家庭 ID<input value={householdId} onChange={event => setHouseholdId(event.target.value)} required /></label>
            <label>主要老人 ID<input value={subjectId} onChange={event => setSubjectId(event.target.value)} required /></label>
            <label>当前操作人 ID<input value={actorId} onChange={event => setActorId(event.target.value)} required /></label>
            {contextKind === 'family_transfer' && <>
              <label>发送者 ID<input value={senderId} onChange={event => setSenderId(event.target.value)} required /></label>
              <label>接收者 ID<span className={styles.inlineHint}>多个用逗号分隔</span><input value={recipientIds} onChange={event => setRecipientIds(event.target.value)} required /></label>
            </>}
          </div>
          <button className={styles.submit} disabled={loading}>{loading ? '正在校验与整理…' : '开始本地整理'}</button>
        </form>

        <aside className={styles.historyPanel}>
          <div className={styles.sectionHeading}><div><span>03</span><h2>最近任务</h2></div><button type="button" className={styles.textButton} onClick={() => void fetchHistory()}>刷新</button></div>
          {history.length === 0 ? <p className={styles.empty}>还没有本地任务。</p> : history.map(item => <button type="button" key={item.jobId} className={`${styles.historyItem} ${job?.jobId === item.jobId ? styles.activeHistory : ''}`} onClick={() => setJob(item)}>
            <span>{statusCopy(item.status)}</span><strong>{item.result?.organization.stories[0]?.titleCandidate ?? '等待整理'}</strong><small>{new Date(item.updatedAt).toLocaleString('zh-CN')}</small>
          </button>)}
        </aside>
      </section>

      {job && <section className={styles.results}>
        <div className={styles.resultHeader}>
          <div><p className={styles.eyebrow}>任务 {job.jobId}</p><h2>{statusCopy(job.status)}</h2></div>
          <div className={styles.metrics}>
            <span><strong>{job.result?.organization.stories.length ?? 0}</strong>故事单元</span>
            <span><strong>{job.metrics?.latencyMs ?? 0} ms</strong>本地耗时</span>
            <span><strong>¥{(job.metrics?.costCny ?? 0).toFixed(2)}</strong>模型费用</span>
            <span><strong>{job.metrics?.modelRequests ?? 0}</strong>模型调用</span>
          </div>
        </div>
        <div className={styles.notice}><strong>AI 整理状态：</strong>当前结果来自规则/确定性集成基线，只用于验证数据流和产品交互。图片本身尚未经过真实视觉模型理解。</div>

        <div className={styles.storyGrid}>
          {job.result?.organization.stories.map(story => <article className={styles.storyCard} key={story.storyId}>
            <div className={styles.storyTop}><div><span className={styles.state}>{storyStateCopy(story.state)}</span><h3>{story.titleCandidate}</h3></div><small>{story.memberContentIds.length} 项内容</small></div>
            <p>{story.summaryCandidate}</p>
            <div className={styles.chips}>{[...story.facets.people, ...story.facets.times, ...story.facets.places, ...story.facets.themes].map(value => <span key={value}>{value}</span>)}</div>
            <div className={styles.members}>
              {story.memberContentIds.map(contentId => {
                const content = contentById.get(contentId);
                const evidence = content ? evidenceById.get(content.evidenceId) : undefined;
                if(!content || !evidence) return null;
                return <div className={styles.member} key={contentId}>
                  {content.modality === 'image'
                    ? <img src={`/api/classification-lab/assets/${job.jobId}/${evidence.evidenceId}`} alt="实验素材" />
                    : <blockquote>{job.originalTextByEvidenceId[evidence.evidenceId]}</blockquote>}
                  <strong>{modalityCopy(content.modality)}</strong>
                  <div className={styles.chips}>{(observationByContent.get(contentId) ?? []).filter(item => item.facet !== 'content_type').map(item => <span key={`${item.facet}-${item.rawValue}`}>{item.facet}: {item.rawValue}</span>)}</div>
                </div>;
              })}
            </div>
            <details><summary>查看 Evidence 依据</summary><p>标题依据：{story.titleSupports.join('、')}</p><p>摘要依据：{story.summarySupports.join('、')}</p></details>
          </article>)}
        </div>

        <div className={styles.detailGrid}>
          <section className={styles.detailCard}><h3>关系与风险</h3>
            {(job.result?.organization.associations.length ?? 0) === 0 ? <p className={styles.empty}>没有产生关系候选。</p> : job.result?.organization.associations.map(item => <div className={styles.row} key={item.associationId}><div><strong>{item.relation}</strong><small>{item.source} · {item.status}</small></div><span>{item.score === undefined ? '用户明确指定' : `规则分 ${item.score.toFixed(2)}`}</span></div>)}
            {job.result?.organization.reviewItems.map(item => <p className={styles.risk} key={item}>{item}</p>)}
          </section>
          <section className={styles.detailCard}><h3>输入 Evidence</h3>
            {job.envelope.evidence.map(item => <div className={styles.row} key={item.evidenceId}><div><strong>{item.modality ? modalityCopy(item.modality === 'text' ? 'user_text' : item.modality === 'transcript' ? 'final_asr' : 'image') : '删除记录'}</strong><small>{item.evidenceId}</small></div><span title={item.sourceHash}>{shortHash(item.sourceHash)}</span></div>)}
          </section>
          <section className={styles.detailCard}><h3>运行审计</h3>
            <div className={styles.row}><span>Provider</span><strong>{job.result?.provider.providerVersion ?? '—'}</strong></div>
            <div className={styles.row}><span>模型</span><strong>{job.result?.provider.modelVersion ?? '—'}</strong></div>
            <div className={styles.row}><span>候选边</span><strong>{job.result?.retrieval.candidateCount ?? 0}</strong></div>
            <div className={styles.row}><span>内部比较</span><strong>{job.result?.retrieval.comparisonCount ?? 0}</strong></div>
            <div className={styles.row}><span>分数含义</span><strong>召回启发值，非概率</strong></div>
          </section>
        </div>
      </section>}

      <footer className={styles.footer}>
        <strong>本地启动</strong>
        <code>CLASSIFICATION_LAB_ENABLED=true CLASSIFICATION_LAB_PROVIDER=deterministic npm run classification:lab</code>
        <p>请使用 <code>http://127.0.0.1:3000/classification-lab</code> 或 localhost 打开。媒体默认保存在系统临时目录；T2 由全栈替换为正式对象存储、数据库、队列和鉴权。</p>
      </footer>
    </main>
  );
}

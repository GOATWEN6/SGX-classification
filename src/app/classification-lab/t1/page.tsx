'use client';

/* eslint-disable @next/next/no-img-element -- guarded local lab assets and object URLs are intentionally rendered without the production optimizer. */

import { useEffect, useMemo, useState } from 'react';
import styles from '../classification-lab.module.css';

const SESSION_KEY = 'sgx-classification-t1-session-v1';
const terminalStatuses = new Set(['succeeded', 'needs_review', 'failed_retryable', 'failed_terminal', 'cancelled']);

type Session = {
  sessionId: string;
  authorizationRevision: string;
  roundCount: number;
};
type AsrJob = {
  jobId: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
  audio: { filename: string; sourceByteLength: number };
  result?: {
    text: string;
    language?: string;
    durationMs: number;
    modelId: string;
    modelVersion: string;
    modelRevision: string;
    runtimeId: string;
    runtimeVersion: string;
  };
  errorCode?: string;
};
type Story = {
  storyId: string;
  state: string;
  titleCandidate: string;
  summaryCandidate: string;
  memberContentIds: string[];
  facets: { people: string[]; times: string[]; places: string[]; themes: string[] };
};
type Observation = {
  contentId: string;
  evidenceId: string;
  facet: string;
  rawValue: string;
  normalizedValue?: string;
  state: string;
  supports: Array<{ evidenceId: string; quote?: string }>;
};
type T1Job = {
  jobId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  redacted: boolean;
  error?: { code: string };
  envelope?: {
    evidence: Array<{ evidenceId: string; modality: 'image' | 'text' | 'transcript'; mimeType: string }>;
    contents: Array<{ contentId: string; evidenceId: string; modality: 'image' | 'user_text' | 'final_asr' }>;
  };
  originalTextByEvidenceId?: Record<string, string>;
  result?: {
    workflowStatus: 'succeeded' | 'needs_review';
    profile: { modelVersion: string; promptVersion: string };
    output: {
      provider: { modelVersion: string; promptVersion: string; evidenceStatus: string };
      organization: { stories: Story[]; reviewItems: string[] };
      observations: Observation[];
      highImpactClaims: Array<{ claimId: string; claimKind: string; value: string; reviewRequired: true }>;
      crossRoundAssociations: Array<{
        associationId: string;
        sourceContentId: string;
        historicalContentId: string;
        method: 'image_text_embedding_topk' | 'authorized_face_embedding_topk';
        rank: number;
        relation: 'possibly_related';
        status: 'candidate_only';
      }>;
      retrieval: { candidateCount: number; comparisonCount: number; maxCandidatesPerContent: number };
    };
  };
  metrics?: {
    latencyMs: number;
    modelRequests: number;
    imageRequests: number;
    inputTokens: number;
    outputTokens: number;
    costCny: number;
  };
};
type Capabilities = {
  model: string;
  promptVersion: string;
  execution: string;
  automaticRetries: number;
  maxImagesPerRound: number;
  personMatching: string;
  rawAudio: string;
  realCallBudget: {
    configured: false;
  } | {
    configured: true;
    authorizationId: string;
    state: 'active' | 'halted' | 'expired';
    used: { requests: number; costCny: number };
    remaining: { requests: number; costCny: number };
  };
};

const errorCopy: Record<string, string> = {
  T1_LAB_DISABLED: 'T1 实验台尚未启用。',
  T1_ASR_DISABLED: 'ASR 前置任务尚未启用。',
  T1_SESSION_SCOPE_MISMATCH: '当前浏览器保存的会话属于另一家庭、老人或操作人，请新建会话。',
  T1_SESSION_REVOKED: '当前会话授权已撤销，请新建会话。',
  T1_TOO_MANY_IMAGES: '每轮最多上传 8 张照片。',
  T1_ASR_AUDIO_REQUIRED: '请选择 PCM WAV 音频。',
  ASR_WAV_REQUIRED: '当前真实 ASR 只接受未压缩 PCM WAV 文件。',
  ASR_AUDIO_SIZE_LIMIT: '音频文件超过 50 MiB。',
  UNSUPPORTED_MEDIA: 'WAV 编码、采样率、声道或时长不受支持。',
  FEATURE_SERVICE_UNAVAILABLE: '云端 ASR/OCR/Embedding 服务暂时不可用。',
  ASR_MODEL_UNAVAILABLE: 'SenseVoice 模型未就绪。',
  ASR_INVALID_OUTPUT: 'ASR 返回内容不符合冻结契约，已停止且未重试。',
  PROVIDER_INVALID_OUTPUT: '多模态模型返回内容不符合契约，已停止且未重试。',
  REAL_CALL_AUTHORIZATION_NOT_CONFIGURED: '真实模型总额度授权尚未接入，任务不会发送给云端模型。',
  REAL_CALL_BUDGET_EXHAUSTED: '真实模型累计调用额度已用完。',
  REAL_CALL_AUTHORIZATION_EXPIRED: '真实模型累计调用授权已到期。',
};

function message(code: string): string { return errorCopy[code] ?? `任务失败：${code}`; }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function statusCopy(value: string): string {
  return ({
    pending: '等待云端 Worker',
    processing: '正在处理',
    succeeded: '已完成',
    needs_review: '已完成，含待确认项',
    failed: '处理失败',
    failed_retryable: '处理失败，可由产品决定是否重跑',
    failed_terminal: '处理失败',
    cancelled: '已取消',
  } as Record<string, string>)[value] ?? value;
}
function facetCopy(value: string): string {
  return ({ person: '人物', time: '时间', place: '地点', event: '事件', scene: '场景', theme: '主题', content_type: '内容类型' } as Record<string, string>)[value] ?? value;
}

export default function ClassificationT1Page() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [audio, setAudio] = useState<File>();
  const [userText, setUserText] = useState('');
  const [finalAsr, setFinalAsr] = useState('');
  const [userTargets, setUserTargets] = useState<number[]>([]);
  const [asrTargets, setAsrTargets] = useState<number[]>([]);
  const [contextKind, setContextKind] = useState<'album_upload' | 'family_transfer'>('album_upload');
  const [householdId, setHouseholdId] = useState('internal_household');
  const [subjectId, setSubjectId] = useState('internal_elder');
  const [actorId, setActorId] = useState('internal_tester');
  const [senderId, setSenderId] = useState('internal_child');
  const [recipientIds, setRecipientIds] = useState('internal_elder');
  const [personMatchingAuthorized, setPersonMatchingAuthorized] = useState(true);
  const [session, setSession] = useState<Session>();
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [asrJob, setAsrJob] = useState<AsrJob>();
  const [job, setJob] = useState<T1Job>();
  const [history, setHistory] = useState<T1Job[]>([]);
  const [phase, setPhase] = useState<'idle' | 'asr' | 'classification'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    const urls = files.map(file => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [files]);

  const rememberSession = (value: Session) => {
    setSession(value);
    localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  };

  const fetchHistory = async (sessionId: string) => {
    const response = await fetch(`/api/classification-lab/t1?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const body = await response.json();
    if(!response.ok) throw new Error(body.error?.code ?? 'T1_HISTORY_FAILED');
    setCapabilities(body.capabilities);
    setHistory(body.jobs ?? []);
    if(!job && body.jobs?.length) setJob(body.jobs[0]);
  };

  useEffect(() => {
    const start = async () => {
      try {
        const stored = localStorage.getItem(SESSION_KEY);
        const parsed = stored ? JSON.parse(stored) as Session : undefined;
        if(parsed?.sessionId) {
          setSession(parsed);
          await fetchHistory(parsed.sessionId);
          return;
        }
        const response = await fetch('/api/classification-lab/t1', { cache: 'no-store' });
        const body = await response.json();
        if(!response.ok) throw new Error(body.error?.code ?? 'T1_CAPABILITIES_FAILED');
        setCapabilities(body.capabilities);
      } catch(value) {
        const code = value instanceof Error ? value.message : 'T1_CAPABILITIES_FAILED';
        setError(message(code));
      }
    };
    void start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTarget = (index: number, current: number[], update: (value: number[]) => void) => {
    update(current.includes(index) ? current.filter(value => value !== index) : [...current, index].sort((a, b) => a - b));
  };

  const pollAsr = async (sessionId: string, jobId: string): Promise<AsrJob> => {
    for(let attempt = 0; attempt < 600; attempt += 1) {
      const response = await fetch(`/api/classification-lab/t1/asr?sessionId=${encodeURIComponent(sessionId)}&jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'T1_ASR_POLL_FAILED');
      const current = body.job as AsrJob;
      setAsrJob(current);
      if(['succeeded', 'failed', 'cancelled'].includes(current.status)) return current;
      await delay(2_000);
    }
    throw new Error('T1_ASR_POLL_TIMEOUT');
  };

  const transcribe = async () => {
    if(!audio || phase !== 'idle') return;
    setPhase('asr');
    setError('');
    try {
      const form = new FormData();
      form.append('audio', audio);
      form.append('metadata', JSON.stringify({
        ...(session ? { sessionId: session.sessionId } : {}),
        scope: { householdId, subjectId },
        actorId,
      }));
      const response = await fetch('/api/classification-lab/t1/asr', {
        method: 'POST',
        headers: { 'x-sgx-classification-lab': '1' },
        body: form,
      });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'T1_ASR_SUBMIT_FAILED');
      rememberSession(body.result.session);
      setAsrJob(body.result.job);
      const completed = await pollAsr(body.result.session.sessionId, body.result.job.jobId);
      if(completed.status !== 'succeeded' || !completed.result) throw new Error(completed.errorCode ?? 'T1_ASR_FAILED');
      setFinalAsr(completed.result.text);
    } catch(value) {
      const code = value instanceof Error ? value.message : 'T1_ASR_FAILED';
      setError(message(code));
    } finally { setPhase('idle'); }
  };

  const pollClassification = async (sessionId: string, jobId: string): Promise<T1Job> => {
    for(let attempt = 0; attempt < 600; attempt += 1) {
      const response = await fetch(`/api/classification-lab/t1?sessionId=${encodeURIComponent(sessionId)}&jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'T1_JOB_POLL_FAILED');
      const current = body.job as T1Job;
      setJob(current);
      if(terminalStatuses.has(current.status)) return current;
      await delay(2_000);
    }
    throw new Error('T1_JOB_POLL_TIMEOUT');
  };

  const submit = async () => {
    if(phase !== 'idle') return;
    if(!files.length && !userText.trim() && !finalAsr.trim()) {
      setError('请至少添加一张照片、用户文字或已经完成的 ASR 转写。');
      return;
    }
    if(audio && asrJob?.status !== 'succeeded') {
      setError('已选择音频，请先运行真实 ASR；确认转写后再提交分类。');
      return;
    }
    setPhase('classification');
    setError('');
    try {
      const form = new FormData();
      files.forEach(file => form.append('images', file));
      form.append('metadata', JSON.stringify({
        ...(session ? { sessionId: session.sessionId } : {}),
        scope: { householdId, subjectId },
        actorId,
        contextKind,
        ...(contextKind === 'family_transfer' ? {
          senderId,
          recipientIds: recipientIds.split(/[，,\s]+/).map(value => value.trim()).filter(Boolean),
        } : { recipientIds: [] }),
        ...(userText.trim() ? { userText: userText.trim() } : {}),
        ...(finalAsr.trim() ? { finalAsr: finalAsr.trim() } : {}),
        userTextTargetIndexes: userText.trim() && userTargets.length ? userTargets : null,
        finalAsrTargetIndexes: finalAsr.trim() && asrTargets.length ? asrTargets : null,
        personMatchingAuthorized,
        submittedAt: new Date().toISOString(),
      }));
      const response = await fetch('/api/classification-lab/t1', {
        method: 'POST',
        headers: { 'x-sgx-classification-lab': '1' },
        body: form,
      });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'T1_SUBMIT_FAILED');
      rememberSession(body.result.session);
      setJob(body.result.job);
      await pollClassification(body.result.session.sessionId, body.result.job.jobId);
      await fetchHistory(body.result.session.sessionId);
    } catch(value) {
      const code = value instanceof Error ? value.message : 'T1_SUBMIT_FAILED';
      setError(message(code));
    } finally { setPhase('idle'); }
  };

  const resetSession = () => {
    localStorage.removeItem(SESSION_KEY);
    setSession(undefined);
    setHistory([]);
    setJob(undefined);
    setAsrJob(undefined);
    setFinalAsr('');
    setError('');
  };

  const stories = job?.result?.output.organization.stories ?? [];
  const observations = job?.result?.output.observations ?? [];
  const evidenceById = useMemo(() => new Map(job?.envelope?.evidence.map(value => [value.evidenceId, value]) ?? []), [job]);
  const contentById = useMemo(() => new Map(job?.envelope?.contents.map(value => [value.contentId, value]) ?? []), [job]);

  return <main className={styles.page}>
    <header className={styles.hero}>
      <div>
        <p className={styles.eyebrow}>SGX · T1 真实混合链</p>
        <h1>多轮图文语音分类与归纳</h1>
        <p>本页连接产品控制面、VirtAI Worker、OCR、Embedding、授权后人物候选、SenseVoice ASR 与 Qwen/GLM Flash。每轮最多 8 张照片，结果会持久化并在后续轮次进行同家庭稀疏检索。</p>
      </div>
      <div className={styles.modeCard}>
        <strong>Worker Pull · 真实模型</strong>
        <span>{capabilities?.model ?? '等待连接'}</span>
        <small>{session ? `会话 ${session.sessionId.slice(0, 18)}… · ${session.roundCount} 轮` : '尚未建立会话'} · 0 自动重试</small>
        <small>{capabilities?.realCallBudget.configured
          ? `累计额度余 ${capabilities.realCallBudget.remaining.requests} 次 / ¥${capabilities.realCallBudget.remaining.costCny.toFixed(4)}`
          : '累计额度门禁未配置'}</small>
      </div>
    </header>

    {error && <div className={styles.error} role="alert">{error}</div>}

    <section className={styles.workspace}>
      <form className={styles.formPanel} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className={styles.sectionHeading}><div><span>01</span><h2>图片与文字</h2></div><small>1–8 张/轮，也支持纯文字</small></div>
        <label className={styles.dropzone}>
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event => {
            const next = Array.from(event.target.files ?? []).slice(0, 8);
            setFiles(next); setUserTargets([]); setAsrTargets([]);
          }} />
          <strong>{files.length ? `已选择 ${files.length} 张照片` : '选择本轮照片'}</strong>
          <span>JPEG、PNG、WebP；服务端会复核格式、尺寸和哈希</span>
        </label>
        {files.length > 0 && <div className={styles.fileGrid}>{files.map((file, index) => <article className={styles.fileCard} key={`${file.name}-${file.lastModified}`}>
          <img src={previews[index]} alt={file.name} />
          <div><strong>{file.name}</strong><small>{(file.size / 1024).toFixed(1)} KiB</small></div>
          <label><input type="checkbox" disabled={!userText.trim()} checked={userTargets.includes(index)} onChange={() => toggleTarget(index, userTargets, setUserTargets)} />文字指向此图</label>
          <label><input type="checkbox" disabled={!finalAsr.trim()} checked={asrTargets.includes(index)} onChange={() => toggleTarget(index, asrTargets, setAsrTargets)} />语音指向此图</label>
        </article>)}</div>}
        <p className={styles.help}>不勾选时，说明保留为“本批次证据”；AI 可以提出可能关联，但不能擅自改成单图事实。</p>
        <div className={styles.textGrid}>
          <label>用户文字说明<textarea rows={4} value={userText} onChange={event => setUserText(event.target.value)} placeholder="例如：这是父亲退休后第一次和老同事回武汉" /></label>
          <label>最终 ASR（可修改）<textarea rows={4} value={finalAsr} onChange={event => setFinalAsr(event.target.value)} placeholder="运行下方真实 ASR 后自动填入；也可手工粘贴最终转写" /></label>
        </div>

        <div className={styles.sectionHeading}><div><span>02</span><h2>真实语音识别</h2></div><small>PCM WAV · 最大 50 MiB</small></div>
        <label className={styles.dropzone}>
          <input type="file" accept="audio/wav,audio/x-wav" onChange={event => {
            setAudio(event.target.files?.[0]); setAsrJob(undefined); setFinalAsr('');
          }} />
          <strong>{audio?.name ?? '选择一段真实或合成 WAV 语音'}</strong>
          <span>{audio ? `${(audio.size / 1024 / 1024).toFixed(2)} MiB` : '当前服务器 ASR 只接受 16-bit PCM WAV；压缩音频会明确拒绝'}</span>
        </label>
        <button type="button" className={styles.secondaryAction} disabled={!audio || phase !== 'idle'} onClick={() => void transcribe()}>
          {phase === 'asr' ? `ASR：${statusCopy(asrJob?.status ?? 'pending')}…` : '先运行真实 ASR 并查看转写'}
        </button>
        {asrJob && <div className={asrJob.status === 'succeeded' ? styles.success : styles.notice}>
          <strong>{statusCopy(asrJob.status)}</strong>
          {asrJob.result
            ? ` · ${asrJob.result.modelId} ${asrJob.result.modelVersion} · ${(asrJob.result.durationMs / 1000).toFixed(1)} 秒 · ${asrJob.result.language ?? '语言未标注'}`
            : asrJob.errorCode ? ` · ${message(asrJob.errorCode)}` : ' · 原始音频已保存，等待云端 Worker'}
        </div>}

        <div className={styles.sectionHeading}><div><span>03</span><h2>场景与授权</h2></div></div>
        <div className={styles.segmented}>
          <button type="button" className={contextKind === 'album_upload' ? styles.selected : ''} onClick={() => setContextKind('album_upload')}>上传到智能相册</button>
          <button type="button" className={contextKind === 'family_transfer' ? styles.selected : ''} onClick={() => setContextKind('family_transfer')}>家庭双端互传</button>
        </div>
        <div className={styles.fieldGrid}>
          <label>家庭 ID<input value={householdId} onChange={event => setHouseholdId(event.target.value)} disabled={Boolean(session)} required /></label>
          <label>主要老人 ID<input value={subjectId} onChange={event => setSubjectId(event.target.value)} disabled={Boolean(session)} required /></label>
          <label>当前操作人 ID<input value={actorId} onChange={event => setActorId(event.target.value)} disabled={Boolean(session)} required /></label>
          {contextKind === 'family_transfer' && <>
            <label>发送者 ID<input value={senderId} onChange={event => setSenderId(event.target.value)} required /></label>
            <label>接收者 ID<input value={recipientIds} onChange={event => setRecipientIds(event.target.value)} required /></label>
          </>}
        </div>
        <label className={styles.consentRow}>
          <input type="checkbox" checked={personMatchingAuthorized} onChange={event => setPersonMatchingAuthorized(event.target.checked)} />
          <span><strong>本轮授权匿名人物候选匹配</strong><small>系统可形成“人物 A/B”和查找历史相似人物；姓名与亲属关系仍需用户确认。</small></span>
        </label>
        <button className={styles.submit} disabled={phase !== 'idle'}>{phase === 'classification' ? '云端正在抽取、检索和归纳…' : '提交本轮真实分类与归纳'}</button>
      </form>

      <aside className={styles.historyPanel}>
        <div className={styles.sectionHeading}><div><span>04</span><h2>多轮记录</h2></div></div>
        <div className={styles.row}><span>Prompt</span><strong>{capabilities?.promptVersion ?? '—'}</strong></div>
        <div className={styles.row}><span>人物匹配</span><strong>逐轮显式授权</strong></div>
        <div className={styles.row}><span>历史检索</span><strong>同家庭/老人 Top-K</strong></div>
        <div className={styles.row}><span>自动重试</span><strong>{capabilities?.automaticRetries ?? 0}</strong></div>
        <div className={styles.row}><span>真实调用总账本</span><strong>{capabilities?.realCallBudget.configured
          ? `${capabilities.realCallBudget.state === 'active' ? '有效' : capabilities.realCallBudget.state === 'expired' ? '已过期' : '已停止'} · 已用 ${capabilities.realCallBudget.used.requests} 次`
          : '未配置'}</strong></div>
        {session && <button type="button" className={styles.secondaryAction} onClick={() => void fetchHistory(session.sessionId)}>刷新任务</button>}
        {history.length === 0 ? <p className={styles.empty}>本会话还没有分类任务。</p> : history.map(item => <button type="button" key={item.jobId} className={`${styles.historyItem} ${job?.jobId === item.jobId ? styles.activeHistory : ''}`} onClick={() => setJob(item)}>
          <span>{statusCopy(item.status)}</span>
          <strong>{item.result?.output.organization.stories[0]?.titleCandidate ?? '等待 AI 整理'}</strong>
          <small>{new Date(item.updatedAt).toLocaleString('zh-CN')}</small>
        </button>)}
        {session && <button type="button" className={styles.dangerAction} onClick={resetSession}>在本机新建另一测试会话</button>}
        <p className={styles.help}>新建本机会话不会删除服务端既有记录。正式产品由账号、家庭成员权限和撤回接口管理会话。</p>
      </aside>
    </section>

    {job && <section className={styles.results}>
      <div className={styles.resultHeader}>
        <div><p className={styles.eyebrow}>任务 {job.jobId}</p><h2>{statusCopy(job.status)}</h2></div>
        <div className={styles.metrics}>
          <span><strong>{stories.length}</strong>故事单元</span>
          <span><strong>{job.metrics?.modelRequests ?? 0}</strong>VLM 请求</span>
          <span><strong>¥{(job.metrics?.costCny ?? 0).toFixed(4)}</strong>本任务费用</span>
          <span><strong>{job.metrics ? `${(job.metrics.latencyMs / 1000).toFixed(1)} 秒` : '—'}</strong>端到端耗时</span>
        </div>
      </div>
      {job.error && <div className={styles.error}>{message(job.error.code)}</div>}
      {!job.result && !job.error && <div className={styles.notice}>任务已持久化，正在等待或由 VirtAI Worker 处理。刷新页面不会丢失任务。</div>}
      {job.result && <>
        <div className={styles.notice}><strong>AI 整理：</strong>标题、摘要、人物候选和关系仍带候选状态；用户原文独立保留，高影响事实不会直接写入长期 Memory。</div>
        <div className={styles.storyGrid}>{stories.map(story => <article className={styles.storyCard} key={story.storyId}>
          <div className={styles.storyTop}><div><span className={styles.state}>AI 整理</span><h3>{story.titleCandidate}</h3></div><small>{story.memberContentIds.length} 项内容</small></div>
          <p>{story.summaryCandidate}</p>
          <div className={styles.chips}>{[...story.facets.people, ...story.facets.times, ...story.facets.places, ...story.facets.themes].map((value, index) => <span key={`${value}-${index}`}>{value}</span>)}</div>
          <div className={styles.members}>{story.memberContentIds.map(contentId => {
            const content = contentById.get(contentId);
            const evidence = content ? evidenceById.get(content.evidenceId) : undefined;
            if(!content || !evidence) return null;
            return <article className={styles.member} key={contentId}>
              {content.modality === 'image' && session
                ? <img src={`/api/classification-lab/t1/assets/${job.jobId}/${evidence.evidenceId}?sessionId=${encodeURIComponent(session.sessionId)}`} alt="本轮分类照片" />
                : <blockquote>{job.originalTextByEvidenceId?.[evidence.evidenceId] ?? content.modality}</blockquote>}
              <strong>{content.modality === 'image' ? '照片' : content.modality === 'user_text' ? '用户原文' : '最终 ASR'}</strong>
              {(observations.filter(item => item.contentId === contentId)).map((item, index) => <div className={styles.row} key={`${item.facet}-${index}`}><span>{facetCopy(item.facet)}</span><strong>{item.normalizedValue ?? item.rawValue}</strong></div>)}
            </article>;
          })}</div>
        </article>)}</div>
        <div className={styles.detailGrid}>
          <section className={styles.detailCard}><h3>模型与 Prompt</h3>
            <div className={styles.row}><span>模型</span><strong>{job.result.output.provider.modelVersion}</strong></div>
            <div className={styles.row}><span>Prompt</span><strong>{job.result.output.provider.promptVersion}</strong></div>
            <div className={styles.row}><span>输入 Token</span><strong>{job.metrics?.inputTokens ?? 0}</strong></div>
            <div className={styles.row}><span>输出 Token</span><strong>{job.metrics?.outputTokens ?? 0}</strong></div>
          </section>
          <section className={styles.detailCard}><h3>稀疏检索</h3>
            <div className={styles.row}><span>候选</span><strong>{job.result.output.retrieval.candidateCount}</strong></div>
            <div className={styles.row}><span>实际比较</span><strong>{job.result.output.retrieval.comparisonCount}</strong></div>
            <div className={styles.row}><span>每项上限</span><strong>{job.result.output.retrieval.maxCandidatesPerContent}</strong></div>
            <p className={styles.help}>检索值只负责缩小候选范围，不作为概率、真实准确率或自动确认事实。</p>
          </section>
          <section className={styles.detailCard}><h3>跨轮次候选关联</h3>
            {job.result.output.crossRoundAssociations.length === 0
              ? <p className={styles.empty}>本轮没有找到已授权的历史候选。</p>
              : job.result.output.crossRoundAssociations.map(item => <div className={styles.row} key={item.associationId}>
                <span>{item.method === 'authorized_face_embedding_topk' ? '匿名人物候选' : '图文语义候选'} · 第 {item.rank} 位</span>
                <strong>{item.sourceContentId} → {item.historicalContentId}</strong>
              </div>)}
            <p className={styles.help}>这里只表示“可能相关”，可用于搜索和相册建议；不会据此确认身份、亲属关系、同一事件或长期 Memory。</p>
          </section>
          <section className={styles.detailCard}><h3>待确认高影响信息</h3>
            {job.result.output.highImpactClaims.length === 0 && job.result.output.organization.reviewItems.length === 0
              ? <p className={styles.empty}>没有高影响候选。</p>
              : <>{job.result.output.highImpactClaims.map(claim => <p className={styles.risk} key={claim.claimId}>{claim.claimKind}：{claim.value}</p>)}
                {job.result.output.organization.reviewItems.map(value => <p className={styles.risk} key={value}>{value}</p>)}</>}
          </section>
        </div>
      </>}
    </section>}
  </main>;
}

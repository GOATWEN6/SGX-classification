'use client';

/* eslint-disable @next/next/no-img-element -- local authorized assets are intentionally rendered without the production optimizer. */

import { useEffect, useMemo, useState } from 'react';
import styles from '../../classification-lab.module.css';

const SESSION_KEY = 'sgx-classification-t1-session-v1';

type Session = { sessionId: string; roundCount: number };
type Content = { contentId: string; evidenceId: string; modality: 'image' | 'user_text' | 'final_asr' };
type AlbumJob = {
  jobId: string;
  status: string;
  updatedAt: string;
  redacted: boolean;
  envelope?: { contents: Content[] };
  originalTextByEvidenceId?: Record<string, string>;
  result?: { output: { organization: { stories: Array<{
    storyId: string;
    titleCandidate: string;
    summaryCandidate: string;
    memberContentIds: string[];
    facets: { people: string[]; times: string[]; places: string[]; themes: string[] };
  }> } } };
};

export default function ClassificationT1AlbumPage() {
  const [session, setSession] = useState<Session>();
  const [jobs, setJobs] = useState<AlbumJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = async (current: Session) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/classification-lab/t1?sessionId=${encodeURIComponent(current.sessionId)}`, { cache: 'no-store' });
      const body = await response.json();
      if(!response.ok) throw new Error(body.error?.code ?? 'T1_ALBUM_FAILED');
      setJobs((body.jobs ?? []).filter((job: AlbumJob) => !job.redacted && Boolean(job.result)));
    } catch {
      setError('智能相册读取失败，请返回实验页检查服务状态。');
    } finally { setLoading(false); }
  };

  useEffect(() => {
    const stored = localStorage.getItem(SESSION_KEY);
    if(!stored) { setLoading(false); return; }
    try {
      const parsed = JSON.parse(stored) as Session;
      if(!parsed.sessionId) throw new Error('INVALID_SESSION');
      setSession(parsed);
      void refresh(parsed);
    } catch {
      setError('本机没有可用的 T1 测试会话，请先完成一次分类。');
      setLoading(false);
    }
  }, []);

  const storyCount = useMemo(() => jobs.reduce((sum, job) => sum + (job.result?.output.organization.stories.length ?? 0), 0), [jobs]);

  return <main className={styles.page}>
    <header className={styles.hero}>
      <div>
        <p className={styles.eyebrow}>SGX · T1 智能相册</p>
        <h1>多轮内容已经整理到这里</h1>
        <p>按故事展示已完成任务中的照片、用户原文、最终 ASR、AI 标题、摘要和筛选标签。刷新页面后仍从服务端持久化记录读取。</p>
        <a className={styles.albumAction} href="/classification-lab/t1">返回上传与语音输入</a>
      </div>
      <div className={styles.modeCard}>
        <strong>当前测试会话</strong>
        <span>{storyCount} 个故事</span>
        <small>{jobs.length} 轮已完成分类 · AI 整理</small>
      </div>
    </header>

    {error && <div className={styles.error} role="alert">{error}</div>}
    {!session && !loading && <section className={styles.results}>
      <h2>还没有可打开的智能相册</h2>
      <p>请先返回 T1 页面，上传照片或输入文字、语音并完成一次真实分类。</p>
    </section>}
    {session && <section className={styles.results}>
      <div className={styles.resultHeader}>
        <div><p className={styles.eyebrow}>会话 {session.sessionId}</p><h2>智能相册</h2></div>
        <button type="button" className={styles.secondaryAction} disabled={loading} onClick={() => void refresh(session)}>{loading ? '读取中…' : '刷新相册'}</button>
      </div>
      {!loading && jobs.length === 0 && <p className={styles.empty}>本会话还没有已完成的故事单元。</p>}
      <div className={styles.albumGrid}>{jobs.flatMap(job => (job.result?.output.organization.stories ?? []).map(story => {
        const contents = new Map((job.envelope?.contents ?? []).map(content => [content.contentId, content]));
        const facets = [...story.facets.people, ...story.facets.times, ...story.facets.places, ...story.facets.themes];
        return <article className={styles.albumCard} key={`${job.jobId}-${story.storyId}`}>
          <div className={styles.storyTop}><div><span className={styles.state}>AI 整理</span><h3>{story.titleCandidate}</h3></div><small>{new Date(job.updatedAt).toLocaleDateString('zh-CN')}</small></div>
          <p>{story.summaryCandidate}</p>
          <div className={styles.chips}>{facets.map((facet, index) => <span key={`${facet}-${index}`}>{facet}</span>)}</div>
          <div className={styles.albumMembers}>{story.memberContentIds.map(contentId => {
            const content = contents.get(contentId);
            if(!content) return null;
            if(content.modality === 'image') return <img key={contentId}
              src={`/api/classification-lab/t1/assets/${job.jobId}/${content.evidenceId}?sessionId=${encodeURIComponent(session.sessionId)}`}
              alt={story.titleCandidate} />;
            return <blockquote key={contentId}>
              <small>{content.modality === 'user_text' ? '用户原文' : '语音转写'}</small>
              {job.originalTextByEvidenceId?.[content.evidenceId] ?? '原文不可用'}
            </blockquote>;
          })}</div>
        </article>;
      }))}</div>
    </section>}
  </main>;
}

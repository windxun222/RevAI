import { useEffect, useState } from 'react';
import { Finding, AnalysisSummary, AnalysisStats, StreamEvent } from '../types';
import { createAnalysisStream, getAnalysis, feedbackFinding } from '../lib/api';
import { SummaryCard } from '../components/SummaryCard';
import { FindingList } from '../components/FindingList';
import { DiffViewer } from '../components/DiffViewer';
import { ProgressBar } from '../components/ProgressBar';
import { SeverityChart } from '../components/SeverityChart';
import { ReviewPublisher } from '../components/ReviewPublisher';
import { ArrowLeft, Loader, CheckCircle, AlertTriangle } from 'lucide-react';

interface AProps {
  analysisId: string;
  prUrl: string;
  status: string;
  setStatus: (s: string) => void;
  progress: number;
  setProgress: (p: number) => void;
  findings: Finding[];
  setFindings: (f: Finding[] | ((prev: Finding[]) => Finding[])) => void;
  summary: AnalysisSummary | undefined;
  setSummary: (s: AnalysisSummary | undefined) => void;
  stats: AnalysisStats | null;
  setStats: (s: AnalysisStats | null) => void;
  pr: any;
  setPr: (p: any) => void;
  l1Complete: boolean;
  setL1Complete: (b: boolean) => void;
  l2Complete: boolean;
  setL2Complete: (b: boolean) => void;
  onBack: () => void;
}

export function Analysis({
  analysisId,
  prUrl,
  status: _status,
  setStatus,
  progress,
  setProgress,
  findings,
  setFindings,
  summary,
  setSummary,
  stats,
  setStats,
  pr,
  setPr,
  l1Complete,
  setL1Complete,
  l2Complete,
  setL2Complete,
  onBack,
}: AProps) {
  const [serr, setSerr] = useState<string | null>(null);
  const [tab, setTab] = useState<'findings' | 'diff'>('findings');
  const [selFile, setSelFile] = useState<string | null>(null);
  const [selLine, setSelLine] = useState<number | null>(null);
  const [showRM, setShowRM] = useState(false);

  useEffect(() => {
    const close = createAnalysisStream(
      analysisId,
      (e: StreamEvent) => {
        setStatus(e.status || 'analyzing');
        setProgress(e.progress || 0);
        if (e.l1Complete) setL1Complete(true);
        if (e.l2Complete) setL2Complete(true);
      },
      async (e: StreamEvent) => {
        setStatus(e.status || 'completed');
        setProgress(100);
        setFindings(e.findings || []);
        setSummary(e.summary);
        setStats(e.stats || null);
        setL1Complete(true);
        if (e.status !== 'error') setL2Complete(true);
        try {
          const r = await getAnalysis(analysisId);
          if (r.pr) setPr(r.pr);
        } catch (err: any) {
          setSerr(err.message || 'Failed to load PR data');
        }
      },
      (err: string) => {
        setSerr(err);
      },
      // onFinding: append each streamed finding incrementally
      (e: StreamEvent) => {
        if (e.finding) {
          setFindings(prev => [...prev, e.finding!]);
        }
      }
    );
    return close;
  }, [analysisId]);

  const isLoading = !pr || progress < 100;
  const hasError = serr || _status === 'error';

  return (
    <div className="p-4">
      {pr && (
        <div className="flex items-center gap-3 mb-4 text-xs text-gray-400">
          <button onClick={onBack} className="hover:text-white">
            <ArrowLeft size={14} />
          </button>
          <a
            href={pr.htmlUrl}
            target="_blank"
            rel="noopener"
            className="font-medium text-gray-200 hover:text-indigo-400 truncate max-w-lg"
          >
            {pr.owner}/{pr.repo}#{pr.number}
          </a>
          <span className="text-gray-600">—</span>
          <span className="truncate max-w-md">{pr.title}</span>
        </div>
      )}

      {isLoading && !hasError && (
        <div className="mb-6 p-4 rounded-lg bg-gray-900 border border-gray-800">
          <div className="flex items-center gap-3 mb-2">
            <Loader size={16} className="animate-spin text-indigo-400" />
            <span className="text-sm font-medium">Analyzing PR...</span>
          </div>
          <ProgressBar progress={progress} />
          
          <div className="flex justify-between mt-2 text-[10px] text-gray-500">
            <span className={l1Complete ? 'text-green-400' : ''}>
              {l1Complete ? (
                <CheckCircle size={10} className="inline" />
              ) : (
                <Loader size={10} className="inline animate-spin" />
              )}{' '}
              L1 Static
            </span>
            
            {/* 修复点：删除了这里原本多出来的 "}" */}
            <span className={l2Complete ? 'text-green-400' : ''}>
              {l2Complete ? (
                <CheckCircle size={10} className="inline" />
              ) : (
                <Loader size={10} className="inline animate-spin" />
              )}{' '}
              L2 DeepSeek
            </span>

            {l2Complete && findings.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 text-[10px]">
                {findings.filter((f) => f.source === 'L2').length} issues
              </span>
            )}
          </div>
        </div>
      )}

      {hasError && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-3">
          <AlertTriangle size={16} className="text-red-400" />
          <div>
            <p className="text-sm text-red-400">Error</p>
            <p className="text-xs text-red-400/70">{serr || 'Unknown'}</p>
          </div>
        </div>
      )}

      {pr && !isLoading && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <SummaryCard summary={summary} stats={stats} />
            </div>
            <div>
              <SeverityChart stats={stats} />
            </div>
          </div>

          <div className="flex gap-1 border-b border-gray-800">
            {(['findings', 'diff'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-xs font-medium transition-colors ${
                  tab === t
                    ? 'text-indigo-400 border-b-2 border-indigo-400'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {t === 'findings' ? 'Findings' : 'Diff Viewer'}
                {t === 'findings' && stats && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-gray-800 text-[10px]">
                    {stats.total}
                  </span>
                )}
              </button>
            ))}
            <div className="flex-1" />
            {pr && (
              <button
                onClick={() => setShowRM(true)}
                className="px-3 py-1.5 rounded text-xs bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30"
              >
                Post to GitHub
              </button>
            )}
          </div>

          {tab === 'findings' && (
            <FindingList
              findings={findings}
              onFeedback={async (fid, feedback) => {
                try {
                  await feedbackFinding(analysisId, fid, feedback);
                  setFindings(
                    findings.map((f) =>
                      f.id === fid ? { ...f, userFeedback: feedback } : f
                    )
                  );
                } catch {
                  /* ignore error */
                }
              }}
              onNavigate={(f, ln) => {
                setSelFile(f);
                setSelLine(ln);
                setTab('diff');
              }}
              onFindingsChange={setFindings}
            />
          )}
          
          {tab === 'diff' && pr && (
            <DiffViewer
              diff={pr.diff}
              findings={findings}
              selectedFile={selFile}
              selectedLine={selLine}
            />
          )}
        </div>
      )}

      {showRM && pr && (
        <ReviewPublisher
          analysisId={analysisId}
          findings={findings}
          owner={pr.owner}
          repo={pr.repo}
          onClose={() => setShowRM(false)}
        />
      )}
    </div>
  );
}
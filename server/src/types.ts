export interface Finding {
  id: string; file: string; line: number; endLine?: number;
  category: 'security' | 'quality' | 'style';
  severity: 'critical' | 'warning' | 'info';
  title: string; description: string; suggestion: string;
  codeSnippet: string; confidence: number;
  source: 'L1' | 'L2'; ruleId?: string; userFeedback?: 'ignored' | 'false_positive';
}
export interface FileChange { filename: string; status: 'added' | 'modified' | 'removed' | 'renamed'; additions: number; deletions: number; patch?: string; previousFilename?: string; }
export interface PrMetadata { number: number; title: string; body: string; author: string; repo: string; owner: string; baseBranch: string; headBranch: string; files: FileChange[]; additions: number; deletions: number; changedFiles: number; diff: string; commits: number; htmlUrl: string; }
export interface AnalysisSummary { intent: string; totalFiles: number; totalAdditions: number; totalDeletions: number; modules: string[]; riskLevel: 'low' | 'medium' | 'high'; }
export interface AnalysisResult { id: string; status: 'pending' | 'analyzing' | 'L1_complete' | 'completed' | 'error'; progress: number; pr: PrMetadata; summary?: AnalysisSummary; findings: Finding[]; l1Complete: boolean; l2Complete: boolean; startedAt: string; completedAt?: string; error?: string; }

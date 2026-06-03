import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import { fetchPrData } from '../services/github';
import { runL1Analysis } from '../analysis/L1-engine';
import { runL2Analysis, generateSummary, isL2Available } from '../services/deepseek';
import { aggregateFindings, getStats } from '../analysis/aggregator';
import { AnalysisResult, Finding } from '../types';

export const analyzeRouter = Router();
const analysisStore = new Map<string, AnalysisResult>();
// Event emitters per analysis ID for push-based SSE streaming
const emitters = new Map<string, EventEmitter>();

analyzeRouter.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { prUrl, githubToken } = req.body;
    if (!prUrl) return res.status(400).json({ error: 'prUrl is required' });
    const id = uuid();
    const result: AnalysisResult = { id, status: 'pending', progress: 0, pr: null as any, findings: [], l1Complete: false, l2Complete: false, startedAt: new Date().toISOString() };
    analysisStore.set(id, result);
    emitters.set(id, new EventEmitter());
    runAnalysis(id, prUrl, githubToken).catch(err => { const s = analysisStore.get(id); if (s) { s.status = 'error'; s.error = err.message; } const e = emitters.get(id); if (e) e.emit('complete'); });
    return res.json({ id, status: 'pending' });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

analyzeRouter.get('/analyze/:id', (req: Request, res: Response) => {
  const r = analysisStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Analysis not found' });
  return res.json(r);
});

analyzeRouter.get('/analyze/:id/stream', (req: Request, res: Response) => {
  const id = req.params.id;
  const result = analysisStore.get(id);
  if (!result) return res.status(404).json({ error: 'Analysis not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  const emitter = emitters.get(id);
  if (!emitter) { res.end(); return; }

  let lastProgress = -1;

  // Poll progress periodically (for non-finding progress updates)
  const interval = setInterval(() => {
    const current = analysisStore.get(id);
    if (!current) { clearInterval(interval); res.end(); return; }
    if (current.progress !== lastProgress) {
      res.write(`data: ${JSON.stringify({ type: 'progress', status: current.status, progress: current.progress, l1Complete: current.l1Complete, l2Complete: current.l2Complete, findingsCount: current.findings.length, l2FindingsCount: current.findings.filter(f => f.source === 'L2').length })}\n\n`);
      lastProgress = current.progress;
    }
  }, 500);

  // Push individual findings as they arrive from L2 streaming
  const onFinding = (finding: Finding) => {
    res.write(`data: ${JSON.stringify({ type: 'finding', finding })}\n\n`);
  };

  // Complete handler
  const onComplete = () => {
    clearInterval(interval);
    const current = analysisStore.get(id);
    if (current) {
      res.write(`data: ${JSON.stringify({ type: 'complete', status: current.status, summary: current.summary, findings: current.findings, error: current.error, stats: getStats(current.findings) })}\n\n`);
    }
    res.end();
  };

  emitter.on('finding', onFinding);
  emitter.on('complete', onComplete);

  req.on('close', () => {
    clearInterval(interval);
    emitter.off('finding', onFinding);
    emitter.off('complete', onComplete);
  });
});

analyzeRouter.put('/analyze/:id/findings/:findingId/feedback', (req: Request, res: Response) => {
  const r = analysisStore.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Analysis not found' });
  const f = r.findings.find(f => f.id === req.params.findingId);
  if (!f) return res.status(404).json({ error: 'Finding not found' });
  const { feedback } = req.body;
  if (feedback !== 'ignored' && feedback !== 'false_positive') return res.status(400).json({ error: 'feedback must be "ignored" or "false_positive"' });
  f.userFeedback = feedback;
  return res.json({ success: true, feedback });
});

analyzeRouter.post('/analyze/:id/post-review', async (req: Request, res: Response) => {
  try {
    const result = analysisStore.get(req.params.id);
    if (!result) return res.status(404).json({ error: 'Analysis not found' });
    const { findingIds, githubToken } = req.body;
    if (!Array.isArray(findingIds) || findingIds.length === 0) return res.status(400).json({ error: 'findingIds array is required' });
    if (!githubToken) return res.status(400).json({ error: 'GitHub token is required' });
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: githubToken });
    const selected = result.findings.filter(f => findingIds.includes(f.id));
    const comments = selected.map(f => `**${f.severity.toUpperCase()}**: ${f.title} [${f.category}]\n\n${f.description}\n\n**Suggestion:** ${f.suggestion}\n\n\`\`\`\n${f.codeSnippet}\n\`\`\`\n\n> Reviewed by RevAI | Confidence: ${Math.round(f.confidence * 100)}%`);
    const body = `## AI Code Review\n\n${comments.join('\n\n---\n\n')}`;
    await octokit.pulls.createReview({ owner: result.pr.owner, repo: result.pr.repo, pull_number: result.pr.number, body, event: 'COMMENT' });
    return res.json({ success: true, commentCount: comments.length });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

async function runAnalysis(id: string, prUrl: string, githubToken?: string) {
  const result = analysisStore.get(id)!;
  const emitter = emitters.get(id);
  result.status = 'analyzing'; result.progress = 5;
  const pr = await fetchPrData(prUrl, githubToken);
  result.pr = pr; result.progress = 15;
  const l1Findings = runL1Analysis(pr);
  result.findings = l1Findings; result.l1Complete = true; result.progress = 40;
  if (isL2Available()) {
    try {
      await runL2Analysis(pr, (finding) => {
        result.findings.push(finding);
        // Emit the individual finding to connected SSE clients
        if (emitter) emitter.emit('finding', finding);
      });
      // Re-aggregate after all L2 findings are in (for dedup/sort)
      const l1Only = result.findings.filter(f => f.source === 'L1');
      const l2Only = result.findings.filter(f => f.source === 'L2');
      result.findings = aggregateFindings(l1Only, l2Only);
      result.progress = 90;
    } catch (err: any) { console.error('L2 analysis error:', err.message); }
  }
  result.l2Complete = true;
  try {
    if (isL2Available()) {
      const s = await generateSummary(pr);
      result.summary = { intent: s.intent, totalFiles: pr.changedFiles, totalAdditions: pr.additions, totalDeletions: pr.deletions, modules: s.modules, riskLevel: s.riskLevel };
    } else {
      result.summary = { intent: `${pr.title} - ${pr.changedFiles} files`, totalFiles: pr.changedFiles, totalAdditions: pr.additions, totalDeletions: pr.deletions, modules: [], riskLevel: pr.changedFiles > 20 ? 'high' : pr.changedFiles > 10 ? 'medium' : 'low' };
    }
  } catch {}
  result.status = 'completed'; result.progress = 100; result.completedAt = new Date().toISOString();
  if (emitter) emitter.emit('complete');
}


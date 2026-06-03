import { Finding } from '../types';
export function aggregateFindings(l1Findings: Finding[], l2Findings: Finding[]): Finding[] {
  const merged: Finding[] = [...l1Findings];
  for (const l2 of l2Findings) { const dup = l1Findings.some(l1 => l1.file === l2.file && Math.abs(l1.line - l2.line) <= 2 && l1.category === l2.category); if (!dup) merged.push(l2); else { const e = l1Findings.find(l1 => l1.file === l2.file && Math.abs(l1.line - l2.line) <= 2 && l1.category === l2.category); if (e) { e.confidence = Math.min(1, e.confidence + 0.15); e.description += ' [Confirmed by AI analysis]'; } } }
  const filtered = merged.filter(f => !(f.source === 'L2' && f.confidence < 0.7));
  const so = { critical: 0, warning: 1, info: 2 };
  filtered.sort((a, b) => so[a.severity] !== so[b.severity] ? so[a.severity] - so[b.severity] : b.confidence - a.confidence);
  return filtered;
}
export function getStats(findings: Finding[]) { return { total: findings.length, critical: findings.filter(f => f.severity === 'critical').length, warning: findings.filter(f => f.severity === 'warning').length, info: findings.filter(f => f.severity === 'info').length, security: findings.filter(f => f.category === 'security').length, quality: findings.filter(f => f.category === 'quality').length, style: findings.filter(f => f.category === 'style').length, l1Count: findings.filter(f => f.source === 'L1').length, l2Count: findings.filter(f => f.source === 'L2').length }; }

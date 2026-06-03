import OpenAI from 'openai';
import { Finding } from '../types';
import { buildLLMPrompt, extractChangedFiles } from '../analysis/context-builder';
import { PrMetadata } from '../types';
import { v4 as uuid } from 'uuid';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required for L2 analysis');
    client = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' });
  }
  return client;
}

/** Parse a single JSONL line into a Finding (nullable). Returns null for malformed lines. */
function parseJSONLine(line: string, filename: string): any | null {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {}
  return null;
}

/** Fallback: parse AI response as JSON array (used when streaming yields 0 findings). */
function parseAIJson(content: string): any[] {
  try { const p = JSON.parse(content); return Array.isArray(p) ? p : (p.findings || []); } catch {}
  const codeMatch = content.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  if (codeMatch) {
    try { const p = JSON.parse(codeMatch[1]); return Array.isArray(p) ? p : (p.findings || []); } catch {}
  }
  const arrMatch = content.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }
  console.error('[DeepSeek] Could not parse response:', content.substring(0, 500));
  return [];
}

/** Normalize and validate a raw parsed object into a Finding. */
function toFinding(raw: any, filename: string): Finding {
  return {
    id: uuid(), file: raw.file || filename, line: raw.line || 1,
    category: (['security','quality','style'].includes(raw.category) ? raw.category : 'quality') as Finding['category'],
    severity: (['critical','warning','info'].includes(raw.severity) ? raw.severity : 'warning') as Finding['severity'],
    title: raw.title || 'AI-detected issue', description: raw.description || '',
    suggestion: raw.suggestion || '', codeSnippet: raw.codeSnippet || '',
    confidence: Math.min(1, Math.max(0, raw.confidence || 0.7)), source: 'L2' as const,
  };
}

export async function runL2Analysis(
  pr: PrMetadata,
  onFinding?: (finding: Finding) => void
): Promise<Finding[]> {
  const allFindings: Finding[] = [];
  const changedFiles = extractChangedFiles(pr);
  const concurrency = 3;
  const batches: typeof changedFiles[] = [];
  for (let i = 0; i < changedFiles.length; i += concurrency) batches.push(changedFiles.slice(i, i + concurrency));

  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(file => analyzeFileStreaming(file.filename, file, pr, onFinding))
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') allFindings.push(...r.value);
    }
  }
  return allFindings;
}

async function analyzeFileStreaming(
  filename: string,
  file: { filename: string; additions: number; deletions: number; patch?: string },
  pr: PrMetadata,
  onFinding?: (finding: Finding) => void
): Promise<Finding[]> {
  const findings: Finding[] = [];
  try {
    const c = getClient();
    const prompt = buildLLMPrompt(file, pr, '');
    const stream = await c.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a senior code reviewer. Return one JSON object per line (JSONL format). Each line is a complete finding object. No markdown fences, no array brackets, no commas between objects. No explanation text outside the JSON lines.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 2000,
      stream: true,
    });

    let buffer = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      buffer += delta;
      // Split on newlines and try to parse complete lines
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = parseJSONLine(trimmed, filename);
        if (parsed) {
          const finding = toFinding(parsed, filename);
          findings.push(finding);
          if (onFinding) onFinding(finding);
        }
      }
    }
    // Process any remaining buffer content after stream ends
    if (buffer.trim()) {
      // Try JSONL first
      const parsed = parseJSONLine(buffer.trim(), filename);
      if (parsed) {
        const finding = toFinding(parsed, filename);
        findings.push(finding);
        if (onFinding) onFinding(finding);
      } else {
        // Fallback: try parsing the entire accumulated content as JSON array
        // Reconstruct full content from findings (if any) + remaining buffer
        const fullContent = buffer.trim();
        const fallbackParsed = parseAIJson(fullContent);
        for (const raw of fallbackParsed) {
          const finding = toFinding(raw, filename);
          findings.push(finding);
          if (onFinding) onFinding(finding);
        }
      }
    }

    console.log(`[DeepSeek] ${filename}: ${findings.length} findings (streaming)`);
  } catch (err: any) {
    console.error(`[DeepSeek] Failed for ${filename}:`, err.message);
  }
  return findings;
}

export function isL2Available(): boolean { return !!process.env.DEEPSEEK_API_KEY; }

export async function generateSummary(pr: PrMetadata): Promise<{ intent: string; riskLevel: 'low'|'medium'|'high'; modules: string[] }> {
  try {
    const c = getClient();
    const fileList = pr.files.map(f => `  ${f.status}: ${f.filename} (+${f.additions}/-${f.deletions})`).slice(0, 30).join('\n');
    const resp = await c.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: `Summarize this PR in one sentence. PR title: "${pr.title}". Description: "${(pr.body||'').substring(0,200)}". Files changed: ${pr.changedFiles}, +${pr.additions}/-${pr.deletions}.\n${fileList}\n\nReturn ONLY raw JSON (no markdown): {"intent":"one sentence summary","riskLevel":"low|medium|high","modules":["module1"]}` }],
      temperature: 0.3, max_tokens: 300,
    });
    const content = resp.choices[0]?.message?.content || '{}';
    let p: any = {};
    try { p = JSON.parse(content); } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) try { p = JSON.parse(m[0]); } catch {}
    }
    console.log(`[DeepSeek] Summary: intent="${p.intent}" risk="${p.riskLevel}" modules=${p.modules?.length||0}`);
    return { intent: p.intent || pr.title, riskLevel: p.riskLevel || 'medium', modules: p.modules || [] };
  } catch (err: any) {
    console.error(`[DeepSeek] Summary failed:`, err.message);
    return { intent: pr.title, riskLevel: pr.changedFiles > 20 ? 'high' : pr.changedFiles > 10 ? 'medium' : 'low', modules: [] };
  }
}

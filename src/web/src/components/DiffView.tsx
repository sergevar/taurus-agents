/**
 * Renders a unified diff view for Edit tool calls.
 * Uses the `diff` library for line comparison and highlight.js for syntax coloring.
 */

import { useMemo } from 'react';
import { diffLines, type Change } from 'diff';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import markdown from 'highlight.js/lib/languages/markdown';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('dockerfile', dockerfile);

/** Toggle line numbers globally. */
const SHOW_LINE_NUMBERS = true;

interface DiffViewProps {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

/** Guess highlight.js language from file extension. */
function langFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    md: 'markdown', html: 'xml', xml: 'xml', css: 'css', scss: 'scss',
    sql: 'sql', dockerfile: 'dockerfile', makefile: 'makefile',
  };
  return ext ? map[ext] : undefined;
}

/** Highlight a block of text, returning HTML per line. */
function highlightLines(text: string, lang?: string): string[] {
  if (!text) return [''];
  if (!lang) return text.split('\n').map(l => escapeHtml(l));
  try {
    const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    return html.split('\n');
  } catch {
    return text.split('\n').map(l => escapeHtml(l));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function DiffView({ filePath, oldString, newString, replaceAll }: DiffViewProps) {
  const changes: Change[] = useMemo(() => diffLines(oldString, newString), [oldString, newString]);
  const lang = useMemo(() => langFromPath(filePath), [filePath]);

  // Build a single string from all lines to highlight in one pass (better token state).
  // Then map highlighted lines back to their diff status + line numbers.
  const highlighted = useMemo(() => {
    const allLines: { text: string; type: 'added' | 'removed' | 'context' }[] = [];
    for (const change of changes) {
      const lines = change.value.replace(/\n$/, '').split('\n');
      const type = change.added ? 'added' as const : change.removed ? 'removed' as const : 'context' as const;
      for (const line of lines) allLines.push({ text: line, type });
    }
    const fullText = allLines.map(l => l.text).join('\n');
    const htmlLines = highlightLines(fullText, lang);

    // Compute old/new line numbers
    let oldNum = 1, newNum = 1;
    return allLines.map((l, i) => {
      let oldLn: number | null = null;
      let newLn: number | null = null;
      if (l.type === 'context') { oldLn = oldNum++; newLn = newNum++; }
      else if (l.type === 'removed') { oldLn = oldNum++; }
      else { newLn = newNum++; }
      return { ...l, html: htmlLines[i] ?? '', oldLn, newLn };
    });
  }, [changes, lang]);

  // Width of line number columns adapts to the largest number
  const maxLn = useMemo(() => {
    let maxOld = 0, maxNew = 0;
    for (const l of highlighted) {
      if (l.oldLn != null && l.oldLn > maxOld) maxOld = l.oldLn;
      if (l.newLn != null && l.newLn > maxNew) maxNew = l.newLn;
    }
    return Math.max(maxOld, maxNew);
  }, [highlighted]);
  const lnWidth = `${String(maxLn).length + 1}ch`;

  return (
    <div className="diff-view">
      <div className="diff-view__header">
        <span className="diff-view__file">{filePath}</span>
        {replaceAll && <span className="diff-view__badge">replace all</span>}
      </div>
      <pre className="diff-view__content">
        {highlighted.map((line, i) => {
          const cls = `diff-view__line--${line.type}`;
          const sign = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
          return (
            <div key={i} className={`diff-view__line ${cls}`}>
              {SHOW_LINE_NUMBERS && (
                <span className="diff-view__lns">
                  <span className="diff-view__ln" style={{ width: lnWidth }}>{line.oldLn ?? ''}</span>
                  <span className="diff-view__ln" style={{ width: lnWidth }}>{line.newLn ?? ''}</span>
                </span>
              )}
              <span className="diff-view__sign">{sign}</span>
              <span
                className="diff-view__text"
                dangerouslySetInnerHTML={{ __html: line.html || '\u00A0' }}
              />
            </div>
          );
        })}
      </pre>
    </div>
  );
}

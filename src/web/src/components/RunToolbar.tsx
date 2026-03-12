import { useState, useRef, useEffect } from 'react';
import { PlayCircle, Square, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { StatusDot } from './StatusDot';
import { ContextRing } from './ContextRing';
import { fmtTokens, fmtCost } from '../utils/format';
import type { Run, MessageRecord } from '../types';

// ── Floating run controls (Running / Stop / Resume) ──

interface RunControlsProps {
  run: Run;
  onResume?: () => void;
  onStop?: () => void;
}

export function RunControls({ run, onResume, onStop }: RunControlsProps) {
  const isLive = run.status === 'running' || run.status === 'paused';
  if (!isLive) return null;

  return (
    <div className="run-controls">
      <StatusDot status={run.status} />
      <span>{run.status === 'paused' ? 'Paused' : 'Running'}</span>
      {run.status === 'paused' && onResume && (
        <button className="btn btn--sm" onClick={onResume}>
          <PlayCircle size={11} /> Resume
        </button>
      )}
      {onStop && (
        <button className="btn btn--sm" onClick={onStop}>
          <Square size={11} /> Stop
        </button>
      )}
    </div>
  );
}

// ── Run footer (usage summary + context ring + dropup menu) ──

interface RunFooterProps {
  run: Run;
  messages: MessageRecord[];
  contextLimit: number;
  showMetadata: boolean;
  onToggleMetadata: () => void;
}

/**
 * Estimate current context window usage from the last assistant message.
 *
 * Context used = inputTokens + visibleOutputTokens of the last turn.
 * The input_tokens already includes the full conversation history sent to the LLM.
 * The output becomes part of history for the next turn, minus thinking/reasoning
 * tokens which are discarded between turns.
 *
 * Token semantics by provider:
 *   Anthropic:  outputTokens = visible only (thinking excluded) → no subtraction needed
 *   OpenAI:     outputTokens = total including reasoning → subtract reasoningTokens
 *   OpenRouter:  same as OpenAI
 *
 * Unified: contextUsed = input + output - (reasoningTokens ?? 0)
 */
function estimateContextUsed(messages: MessageRecord[]): number {
  // Find the last assistant message (has token counts)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.input_tokens > 0) {
      const visibleOutput = m.output_tokens - (m.usage?.reasoningTokens ?? 0);
      return m.input_tokens + visibleOutput;
    }
  }
  return 0;
}

export function RunFooter({ run, messages, contextLimit, showMetadata, onToggleMetadata }: RunFooterProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const totalCost = messages.reduce((s, m) => s + (m.cost ?? 0), 0);
  const totalIn = messages.reduce((s, m) => s + m.input_tokens, 0);
  const totalCacheRead = messages.reduce((s, m) => s + (m.usage?.cacheRead ?? 0), 0);
  const cachePct = totalIn > 0 && totalCacheRead > 0 ? Math.round((totalCacheRead / totalIn) * 100) : 0;

  const contextUsed = estimateContextUsed(messages);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  return (
    <div className="run-footer">
      {/* Ghost spacer to balance the menu on the right */}
      <div className="run-footer__menu" style={{ visibility: 'hidden' }} aria-hidden>
        <button className="run-footer__menu-trigger" tabIndex={-1}><ChevronDown size={12} /></button>
      </div>

      {/* Context + cost + cache pill */}
      {totalIn > 0 && (
        <div className="usage-summary">
          {contextLimit > 0 && contextUsed > 0 && (
            <span className="usage-summary__item usage-summary__item--ring">
              <ContextRing used={contextUsed} limit={contextLimit} />
            </span>
          )}
          {contextLimit > 0 && contextUsed > 0 && (
            <span className="usage-summary__item">
              {fmtTokens(contextUsed)} / {fmtTokens(contextLimit)}
            </span>
          )}
          {totalCost > 0 && (
            <span className="usage-summary__item usage-summary__item--cost">
              {fmtCost(totalCost)}
            </span>
          )}
          {cachePct > 0 && (
            <span className="usage-summary__item usage-summary__item--cache">
              {cachePct}% cached
            </span>
          )}
        </div>
      )}

      {/* Dropup chevron */}
      <div className="run-footer__menu" ref={menuRef}>
        <button
          className={`run-footer__menu-trigger${showMetadata ? ' run-footer__menu-trigger--active' : ''}`}
          onClick={() => setMenuOpen(!menuOpen)}
          title="View options"
        >
          <ChevronDown size={12} />
        </button>
        {menuOpen && (
          <div className="run-footer__menu-dropdown">
            <button
              className="run-footer__menu-item"
              onClick={() => { onToggleMetadata(); setMenuOpen(false); }}
            >
              {showMetadata ? <EyeOff size={12} /> : <Eye size={12} />}
              {showMetadata ? 'Hide metadata' : 'Show metadata'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

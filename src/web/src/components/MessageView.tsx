import { useEffect, useRef, useState } from 'react';
import type { MessageRecord } from '../types';
import { Markdown } from './Markdown';
import { JsonKV } from './JsonKV';
import { ScreenshotImage } from './ScreenshotImage';

// ── Collapsible thinking block ──

function ThinkingBlock({ text, defaultCollapsed = true }: { text: string; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  // Auto-collapse when defaultCollapsed changes (e.g., thinking done → output starts)
  useEffect(() => {
    if (defaultCollapsed) setCollapsed(true);
  }, [defaultCollapsed]);

  const charCount = text.length;
  const label = charCount > 1000
    ? `Thinking (${Math.round(charCount / 4).toLocaleString()} tokens)`
    : 'Thinking';

  return (
    <div className={`thinking-block ${collapsed ? 'thinking-block--collapsed' : ''}`}>
      <div className="thinking-block__header" onClick={() => setCollapsed(!collapsed)}>
        <span className="thinking-block__toggle">{collapsed ? '\u25b6' : '\u25bc'}</span>
        <span className="thinking-block__label">{label}</span>
        {collapsed && (
          <span className="thinking-block__preview">
            {text.slice(0, 120).replace(/\n/g, ' ')}{text.length > 120 ? '...' : ''}
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="thinking-block__content">{text}</div>
      )}
    </div>
  );
}

// ── Content block rendering ──

function ContentBlockView({ block }: { block: any }) {
  if (block.type === 'thinking') {
    return <ThinkingBlock text={block.thinking} />;
  }
  if (block.type === 'text') {
    return <Markdown>{block.text}</Markdown>;
  }
  if (block.type === 'tool_use') {
    return (
      <div className="msg-tool-use">
        <div className="msg-tool-use__header">Tool: {block.name}</div>
        <div className="msg-tool-use__input">
          <JsonKV data={block.input} />
        </div>
      </div>
    );
  }
  if (block.type === 'tool_result') {
    const isError = block.is_error;
    return (
      <div className={`msg-tool-result ${isError ? 'error' : ''}`}>
        <div className="msg-tool-result__header">
          Result
          {isError && <span className="msg-tool-result__error"> ERROR</span>}
        </div>
        {typeof block.content === 'string' ? (
          <pre className="msg-tool-result__content">{block.content}</pre>
        ) : Array.isArray(block.content) ? (
          <div className="msg-tool-result__content">
            {block.content.map((sub: any, i: number) => {
              if (sub.type === 'text') return <pre key={i} style={{ margin: 0 }}>{sub.text}</pre>;
              if (sub.type === 'image' && sub.source?.type === 'base64') {
                return (
                  <ScreenshotImage
                    key={i}
                    src={`data:${sub.source.media_type};base64,${sub.source.data}`}
                    alt="Screenshot"
                  />
                );
              }
              return <pre key={i} style={{ margin: 0 }}>{JSON.stringify(sub, null, 2)}</pre>;
            })}
          </div>
        ) : (
          <pre className="msg-tool-result__content">{JSON.stringify(block.content, null, 2)}</pre>
        )}
      </div>
    );
  }
  // Fallback for unknown block types
  return <pre className="msg-raw">{JSON.stringify(block, null, 2)}</pre>;
}

function MessageContent({ content }: { content: unknown }) {
  if (typeof content === 'string') {
    return <Markdown>{content}</Markdown>;
  }
  if (Array.isArray(content)) {
    return (
      <>
        {content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </>
    );
  }
  return <pre className="msg-raw">{JSON.stringify(content, null, 2)}</pre>;
}

// ── Main message view ──

interface MessageViewProps {
  messages: MessageRecord[];
  streamingText?: string;
  streamingThinking?: string;
}

export function MessageView({ messages, streamingText, streamingThinking }: MessageViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasNearBottom = useRef(true);

  // After new messages or streaming text render, scroll to bottom if we were already near it
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasNearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingText, streamingThinking]);

  // On scroll, record whether we're near the bottom
  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    wasNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }

  if (messages.length === 0) {
    return <div className="empty-state">No messages in this run</div>;
  }

  const totalIn = messages.reduce((s, m) => s + m.input_tokens, 0);
  const totalOut = messages.reduce((s, m) => s + m.output_tokens, 0);
  const isStreaming = !!(streamingText || streamingThinking);

  // Auto-collapse thinking when output text starts arriving
  const thinkingDone = !!streamingText;

  return (
    <div className="message-list" ref={containerRef} onScroll={handleScroll}>
      {messages.map(msg => {
        const isOptimistic = msg.id.startsWith('_optimistic_');
        return (
        <div key={msg.id} className={`message message--${msg.role}${isOptimistic ? ' message--optimistic' : ''}`}>
          <div className="message__header">
            <span className="message__role">{msg.role}</span>
            <span className="message__meta">
              {isOptimistic
                ? <span className="message__pill message__pill--sending">sending</span>
                : msg.stop_reason && <span className="message__pill message__pill--stop">{msg.stop_reason}</span>}
              {!isOptimistic && new Date(msg.created_at).toLocaleTimeString()}
            </span>
          </div>
          <div className="message__body">
            <MessageContent content={msg.content} />
          </div>
        </div>
        );
      })}
      {isStreaming && (
        <div className="message message--assistant message--streaming">
          <div className="message__header">
            <span className="message__role">assistant</span>
            <span className="message__meta">
              <span className="message__pill message__pill--streaming">
                {thinkingDone ? 'streaming' : 'thinking'}
              </span>
            </span>
          </div>
          <div className="message__body">
            {streamingThinking && (
              <ThinkingBlock text={streamingThinking} defaultCollapsed={thinkingDone} />
            )}
            {streamingText && <Markdown>{streamingText}</Markdown>}
          </div>
        </div>
      )}
      {totalIn > 0 && (
        <div className="message-list__footer">
          {totalIn.toLocaleString()} input / {totalOut.toLocaleString()} output tokens
        </div>
      )}
    </div>
  );
}

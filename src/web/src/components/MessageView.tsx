import { useEffect, useRef } from 'react';
import type { MessageRecord } from '../types';

function ContentBlock({ block }: { block: any }) {
  if (block.type === 'text') {
    return <div className="msg-text">{block.text}</div>;
  }
  if (block.type === 'tool_use') {
    return (
      <div className="msg-tool-use">
        <div className="msg-tool-use__header">Tool: {block.name}</div>
        <pre className="msg-tool-use__input">{JSON.stringify(block.input, null, 2)}</pre>
      </div>
    );
  }
  if (block.type === 'tool_result') {
    const isError = block.is_error;
    return (
      <div className={`msg-tool-result ${isError ? 'error' : ''}`}>
        <div className="msg-tool-result__header">
          Result{block.tool_use_id ? ` (${block.tool_use_id.slice(0, 8)}...)` : ''}
          {isError && <span className="msg-tool-result__error"> ERROR</span>}
        </div>
        <pre className="msg-tool-result__content">
          {typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content, null, 2)}
        </pre>
      </div>
    );
  }
  // Fallback for unknown block types
  return <pre className="msg-raw">{JSON.stringify(block, null, 2)}</pre>;
}

function MessageContent({ content }: { content: unknown }) {
  if (typeof content === 'string') {
    return <div className="msg-text">{content}</div>;
  }
  if (Array.isArray(content)) {
    return (
      <>
        {content.map((block, i) => (
          <ContentBlock key={i} block={block} />
        ))}
      </>
    );
  }
  return <pre className="msg-raw">{JSON.stringify(content, null, 2)}</pre>;
}

interface MessageViewProps {
  messages: MessageRecord[];
}

export function MessageView({ messages }: MessageViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasNearBottom = useRef(true);

  // After new messages render, scroll to bottom if we were already near it
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasNearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // On scroll, record whether we're near the bottom
  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    wasNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }

  if (messages.length === 0) {
    return <div className="empty-state">No messages in this run</div>;
  }

  return (
    <div className="message-list" ref={containerRef} onScroll={handleScroll}>
      {messages.map(msg => (
        <div key={msg.id} className={`message message--${msg.role}`}>
          <div className="message__header">
            <span className="message__role">{msg.role}</span>
            <span className="message__meta">
              {new Date(msg.created_at).toLocaleTimeString()}
              {msg.input_tokens > 0 && ` | ${msg.input_tokens}in`}
              {msg.output_tokens > 0 && ` / ${msg.output_tokens}out`}
              {msg.stop_reason && ` | ${msg.stop_reason}`}
            </span>
          </div>
          <div className="message__body">
            <MessageContent content={msg.content} />
          </div>
        </div>
      ))}
    </div>
  );
}

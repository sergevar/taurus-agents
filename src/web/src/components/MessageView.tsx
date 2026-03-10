import { useEffect, useRef, useState } from 'react';
import {
  Terminal, FileText, FilePen, FolderSearch, Search,
  Pause, Globe, Download, MonitorPlay, Eye,
  Wrench,
} from 'lucide-react';
import type { MessageRecord } from '../types';
import { Markdown } from './Markdown';
import { JsonKV } from './JsonKV';
import { DiffView } from './DiffView';
import { Lightbox } from './Lightbox';

const TOOL_ICONS: Record<string, typeof Terminal> = {
  Bash: Terminal,
  Read: Eye,
  Write: FileText,
  Edit: FilePen,
  Glob: FolderSearch,
  Grep: Search,
  Pause: Pause,
  WebSearch: Globe,
  WebFetch: Download,
  Browser: MonitorPlay,
};

function ToolHeader({ name, description }: { name: string; description?: string }) {
  const Icon = TOOL_ICONS[name] ?? Wrench;
  return (
    <div className="msg-tool-use__header">
      <Icon size={12} />
      <span>{name}</span>
      {description && <span className="msg-tool-use__desc">{description}</span>}
    </div>
  );
}

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
        <div className="thinking-block__content"><Markdown>{text}</Markdown></div>
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
  if (block.type === 'image' && block.source?.type === 'base64') {
    return (
      <Lightbox
        src={`data:${block.source.media_type};base64,${block.source.data}`}
        alt="Uploaded image"
        className="msg-tool-result__image"
      />
    );
  }
  if (block.type === 'tool_use') {
    const { description, ...inputRest } = block.input ?? {};
    if (block.name === 'Edit' && inputRest.old_string != null && inputRest.new_string != null) {
      return (
        <div className="msg-tool-use">
          <ToolHeader name={block.name} description={description} />
          <div className="msg-tool-use__input msg-tool-use__input--diff">
            <DiffView
              filePath={inputRest.file_path ?? ''}
              oldString={inputRest.old_string}
              newString={inputRest.new_string}
              replaceAll={inputRest.replace_all}
            />
          </div>
        </div>
      );
    }
    if (block.name === 'Bash' && inputRest.command) {
      const { command, ...bashRest } = inputRest;
      const hasExtra = Object.keys(bashRest).length > 0;
      return (
        <div className="msg-tool-use">
          <ToolHeader name={block.name} description={description} />
          <div className="msg-tool-use__cmd">
            <code>{command}</code>
          </div>
          {hasExtra && (
            <div className="msg-tool-use__input">
              <JsonKV data={bashRest} />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="msg-tool-use">
        <ToolHeader name={block.name} description={description} />
        <div className="msg-tool-use__input">
          <JsonKV data={inputRest} />
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
                  <Lightbox
                    key={i}
                    src={`data:${sub.source.media_type};base64,${sub.source.data}`}
                    alt="Screenshot"
                    className="msg-tool-result__image"
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
  streamingToolOutput?: string;
  runStatus?: string;
}

export function MessageView({ messages, streamingText, streamingThinking, streamingToolOutput, runStatus }: MessageViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toolOutputRef = useRef<HTMLPreElement>(null);
  const wasNearBottom = useRef(true);
  const toolOutputNearBottom = useRef(true);

  // After new messages or streaming text render, scroll to bottom if we were already near it
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasNearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingText, streamingThinking, streamingToolOutput]);

  // Auto-scroll the tool output <pre> to its bottom as new content streams in
  useEffect(() => {
    const el = toolOutputRef.current;
    if (el && toolOutputNearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamingToolOutput]);

  // Reset tool output scroll tracking when a new stream starts
  useEffect(() => {
    if (streamingToolOutput) toolOutputNearBottom.current = true;
  }, [!streamingToolOutput]);

  // On scroll, record whether we're near the bottom
  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    wasNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }

  if (messages.length === 0) {
    const label = runStatus === 'running' ? 'Starting...' : 'No messages in this run';
    return <div className="empty-state">{label}</div>;
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
      {streamingToolOutput && (
        <div className="message message--user">
          <div className="message__header">
            <span className="message__role">user</span>
          </div>
          <div className="message__body">
            <div className="msg-tool-result">
              <div className="msg-tool-result__header">Result</div>
              <pre ref={toolOutputRef} className="msg-tool-result__content" onScroll={() => {
                const el = toolOutputRef.current;
                if (el) toolOutputNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
              }}>{streamingToolOutput}</pre>
            </div>
          </div>
        </div>
      )}
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

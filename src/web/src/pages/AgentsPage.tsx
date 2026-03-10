import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Agent, Run, MessageRecord } from '../types';
import { api } from '../api';
import { Sidebar } from '../components/Sidebar';
import { StatusDot } from '../components/StatusDot';
import { MessageView } from '../components/MessageView';
import { InputBar } from '../components/InputBar';
import { CreateAgentModal } from '../components/CreateAgentModal';
import { AgentSettings } from '../components/AgentSettings';
import { Countdown } from '../components/Countdown';
import { useToast, ToastContainer } from '../components/Toast';
import { TreeView, type TreeItem } from '../components/TreeView';
import { useTheme, THEME_LABELS } from '../hooks/useTheme';
import { Play, RotateCw, Square, PlayCircle, RefreshCw, Settings, Palette } from 'lucide-react';
import '../styles/components.scss';

type Tab = 'runs' | 'settings';

function formatRunDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const isSameYear = date.getFullYear() === now.getFullYear();

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).replace(/\s?AM/g, 'am').replace(/\s?PM/g, 'pm');

  if (isToday) return timeStr;

  const SHOW_YESTERDAY = false;
  if (SHOW_YESTERDAY) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday =
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate();
    if (isYesterday) return `yesterday, ${timeStr}`;
  }

  const monthDay = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  if (isSameYear) return `${monthDay}, ${timeStr}`;

  return `${monthDay}, ${date.getFullYear()}, ${timeStr}`;
}

export function AgentsPage() {
  const { agentId, runId } = useParams();
  const navigate = useNavigate();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [runActivity, setRunActivity] = useState<Record<string, string>>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('runs');
  const { toasts, showToast, dismiss } = useToast();
  const { theme, cycleTheme } = useTheme();

  // Remember last selected run per agent so switching back restores it
  const lastRunByAgent = useRef<Record<string, string>>({});

  // Refs so SSE callbacks see latest values without re-subscribing
  const agentIdRef = useRef(agentId);
  const runIdRef = useRef(runId);
  const messagesRef = useRef(messages);
  const streamingTextRef = useRef('');
  const streamingThinkingRef = useRef('');
  const runStreamingRef = useRef<Record<string, string>>({});
  useEffect(() => { agentIdRef.current = agentId; }, [agentId]);
  useEffect(() => {
    runIdRef.current = runId;
    if (agentId && runId) lastRunByAgent.current[agentId] = runId;
  }, [agentId, runId]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ── Load agents ──

  const loadAgents = useCallback(async () => {
    const list = await api.listAgents();
    setAgents(list);
  }, []);

  useEffect(() => {
    loadAgents();
    const interval = setInterval(loadAgents, 30_000);
    return () => clearInterval(interval);
  }, [loadAgents]);

  // ── Load runs when agent changes + auto-select latest ──

  useEffect(() => {
    if (!agentId) {
      setRuns([]);
      setMessages([]);
      return;
    }
    const aid = agentId;
    api.listRuns(aid).then(loadedRuns => {
      if (agentIdRef.current !== aid) return; // stale response
      setRuns(loadedRuns);
      if (loadedRuns.length > 0 && !runIdRef.current) {
        const remembered = lastRunByAgent.current[aid];
        const targetId = remembered && loadedRuns.some(r => r.id === remembered) ? remembered : loadedRuns[0].id;
        navigate(`/agents/${aid}/runs/${targetId}`, { replace: true });
      }
    });
  }, [agentId, navigate]);

  // ── Load messages when run changes ──

  useEffect(() => {
    if (!agentId || !runId) {
      setMessages([]);
      return;
    }
    let stale = false;
    setMessages([]); // clear immediately so we don't show previous run's messages
    api.getRunMessages(agentId, runId).then(msgs => {
      if (!stale) setMessages(msgs);
    });
    return () => { stale = true; };
  }, [agentId, runId]);

  // ── Reset tab when agent changes ──

  useEffect(() => {
    setActiveTab('runs');
  }, [agentId]);

  // ── Optimistic user message helper ──

  function appendOptimisticUserMessage(text: string, images?: import('../components/InputBar').ImageAttachment[]) {
    let content: string | any[] = text;
    if (images && images.length > 0) {
      content = [
        { type: 'text', text },
        ...images.map(img => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        })),
      ];
    }

    const optimistic: MessageRecord = {
      id: `_optimistic_${Date.now()}`,
      run_id: runIdRef.current ?? '',
      seq: Infinity,
      role: 'user',
      content,
      stop_reason: null,
      input_tokens: 0,
      output_tokens: 0,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);
  }

  // ── Incremental message fetch helper ──

  const fetchNewMessages = useCallback(async () => {
    const aid = agentIdRef.current;
    const rid = runIdRef.current;
    if (!aid || !rid) return;

    const currentMsgs = messagesRef.current;
    const realMsgs = currentMsgs.filter(m => !m.id.startsWith('_optimistic_'));
    const maxSeq = realMsgs.length > 0
      ? Math.max(...realMsgs.map(m => m.seq))
      : undefined;

    const newMsgs = await api.getRunMessages(aid, rid, maxSeq);
    if (newMsgs.length > 0) {
      setMessages(prev => {
        const settled = prev.filter(m => !m.id.startsWith('_optimistic_'));
        const existingIds = new Set(settled.map(m => m.id));
        const unique = newMsgs.filter(m => !existingIds.has(m.id));
        return unique.length > 0 ? [...settled, ...unique] : settled;
      });
    }
  }, []);

  // ── SSE: live updates when an agent is selected ──

  useEffect(() => {
    if (!agentId) return;

    streamingTextRef.current = '';
    streamingThinkingRef.current = '';
    runStreamingRef.current = {};
    setStreamingText('');
    setStreamingThinking('');
    setRunActivity({});

    const es = new EventSource(`/api/agents/${agentId}/stream`);

    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        switch (data.type) {
          case 'agent_status':
            setAgents(prev => prev.map(a =>
              a.id === data.agentId ? { ...a, status: data.status } : a,
            ));
            break;

          case 'run_status':
            setRuns(prev => {
              const exists = prev.some(r => r.id === data.runId);
              if (!exists) {
                api.listRuns(agentIdRef.current!).then(setRuns);
                return prev;
              }
              return prev.map(r =>
                r.id === data.runId ? { ...r, status: data.status } : r,
              );
            });
            break;

          case 'run_complete':
            streamingTextRef.current = '';
            streamingThinkingRef.current = '';
            setStreamingText('');
            setStreamingThinking('');
            fetchNewMessages();
            api.listRuns(agentIdRef.current!).then(setRuns);
            loadAgents();
            break;

          case 'agent_paused':
            setAgents(prev => prev.map(a =>
              a.id === data.agentId ? { ...a, status: 'paused' as const } : a,
            ));
            break;

          case 'agent_error':
            setAgents(prev => prev.map(a =>
              a.id === data.agentId ? { ...a, status: 'error' as const } : a,
            ));
            break;

          case 'llm_thinking':
            if (typeof data.text === 'string' && data.runId === runIdRef.current) {
              streamingThinkingRef.current += data.text;
              setStreamingThinking(streamingThinkingRef.current);
            }
            break;

          case 'llm_text':
            if (typeof data.text === 'string') {
              // Accumulate per-run activity for tree secondary text
              runStreamingRef.current[data.runId] = (runStreamingRef.current[data.runId] ?? '') + data.text;
              // Selected run: feed message view
              if (data.runId === runIdRef.current) {
                streamingTextRef.current += data.text;
                setStreamingText(streamingTextRef.current);
              }
            }
            break;

          case 'log':
            if (data.event === 'message.saved') {
              // Snapshot accumulated text as run activity
              if (data.message === 'assistant' && runStreamingRef.current[data.runId]) {
                const text = runStreamingRef.current[data.runId];
                const firstLine = text.split('\n').find(l => l.trim()) ?? text.slice(0, 120);
                setRunActivity(prev => ({ ...prev, [data.runId]: firstLine.slice(0, 120) }));
              }
              delete runStreamingRef.current[data.runId];
              // Selected run: clear streaming and fetch persisted messages
              if (data.runId === runIdRef.current) {
                streamingTextRef.current = '';
                streamingThinkingRef.current = '';
                setStreamingText('');
                setStreamingThinking('');
                fetchNewMessages();
              }
            }
            break;
        }
      } catch { /* ignore parse errors */ }
    };

    return () => es.close();
  }, [agentId, loadAgents, fetchNewMessages]);

  // ── Derived state ──

  const selectedAgent = agents.find(a => a.id === agentId) ?? null;
  const selectedRun = runs.find(r => r.id === runId) ?? null;

  // Adapt runs for TreeView
  const treeRuns: (Run & TreeItem)[] = runs.map(r => ({
    ...r,
    parentId: r.parent_run_id,
  }));

  // ── Actions ──

  async function handleStartRun() {
    if (!agentId) return;
    try {
      const result = await api.startRun(agentId);
      await loadAgents();
      const updatedRuns = await api.listRuns(agentId);
      setRuns(updatedRuns);
      setActiveTab('runs');
      navigate(`/agents/${agentId}/runs/${result.runId}`);
    } catch (err: any) {
      showToast(err.message);
    }
  }

  async function handleContinueRun() {
    if (!agentId || runs.length === 0) return;
    try {
      const latestRunId = runs[0].id;
      await api.startRun(agentId, { run_id: latestRunId });
      await loadAgents();
      const updatedRuns = await api.listRuns(agentId);
      setRuns(updatedRuns);
      setActiveTab('runs');
      navigate(`/agents/${agentId}/runs/${latestRunId}`);
    } catch (err: any) {
      showToast(err.message);
    }
  }

  async function handleStopRun() {
    if (!agentId) return;
    try {
      await api.stopRun(agentId);
      await loadAgents();
      if (runId) {
        const msgs = await api.getRunMessages(agentId, runId);
        setMessages(msgs);
      }
    } catch (err: any) {
      showToast(err.message);
    }
  }

  async function handleStopSelectedRun() {
    if (!agentId || !runId) return;
    try {
      await api.stopSpecificRun(agentId, runId);
      await loadAgents();
      const msgs = await api.getRunMessages(agentId, runId);
      setMessages(msgs);
      const updatedRuns = await api.listRuns(agentId);
      setRuns(updatedRuns);
    } catch (err: any) {
      showToast(err.message);
    }
  }

  async function handleResume() {
    if (!agentId) return;
    const targetRunId = runId || runs[0]?.id;
    if (!targetRunId) return;
    try {
      await api.startRun(agentId, { run_id: targetRunId });
      await loadAgents();
    } catch (err: any) {
      showToast(err.message);
    }
  }

  async function handleSend(message: string, images?: import('../components/InputBar').ImageAttachment[]) {
    if (!agentId || !message.trim()) return;
    appendOptimisticUserMessage(message, images);
    const apiImages = images?.map(({ base64, mediaType }) => ({ base64, mediaType }));

    try {
      if (selectedAgent?.status === 'running' || selectedAgent?.status === 'paused') {
        await api.injectMessage(agentId, message, apiImages, runId);
        return;
      }

      const targetRunId = runId || runs[0]?.id;
      const result = await api.startRun(agentId, {
        input: message,
        images: apiImages,
        ...(targetRunId ? { run_id: targetRunId } : {}),
      });
      await loadAgents();
      const updatedRuns = await api.listRuns(agentId);
      setRuns(updatedRuns);
      setActiveTab('runs');
      navigate(`/agents/${agentId}/runs/${result.runId}`);
    } catch (err: any) {
      showToast(err.message);
    }
  }

  async function handleDelete() {
    if (!agentId || !confirm('Delete this agent?')) return;
    try {
      await api.deleteAgent(agentId);
      navigate('/');
      await loadAgents();
    } catch (err: any) {
      showToast(err.message);
    }
  }

  async function handleCreated(newId: string) {
    setShowCreateModal(false);
    await loadAgents();
    navigate(`/agents/${newId}`);
  }

  function handleSelectRun(id: string) {
    if (agentId) {
      setActiveTab('runs');
      navigate(`/agents/${agentId}/runs/${id}`);
    }
  }

  async function handleRefreshMessages() {
    if (agentId && runId) {
      const msgs = await api.getRunMessages(agentId, runId);
      setMessages(msgs);
      const updatedRuns = await api.listRuns(agentId);
      setRuns(updatedRuns);
    }
  }

  // ── Helpers ──

  const isRunning = selectedAgent?.status === 'running';
  const isPaused = selectedAgent?.status === 'paused';
  const isStopped = !isRunning && !isPaused;

  const isLive = (r: Run) => r.status === 'running' || r.status === 'paused';

  // ── Render ──

  return (
    <div className="app">
      <Sidebar
        agents={agents}
        selectedId={agentId ?? null}
        onCreateClick={() => setShowCreateModal(true)}
      />

      <div className="main">
        {!selectedAgent ? (
          <div className="empty-state">Select or create an agent</div>
        ) : (
          <>
            {/* Agent header */}
            <div className="panel-header">
              <div className="panel-header__info">
                <StatusDot status={selectedAgent.status} />
                <h2>{selectedAgent.name}</h2>
                <span className="panel-header__meta">{selectedAgent.model}</span>
                {selectedAgent.schedule && selectedAgent.next_run && !isRunning && (
                  <Countdown targetDate={selectedAgent.next_run} />
                )}
              </div>
              <div className="panel-header__actions">
                {isStopped && <button className="btn primary" onClick={handleStartRun}><Play size={13} /> New Run</button>}
                {isStopped && runs.length > 0 && <button className="btn" onClick={handleContinueRun}><RotateCw size={13} /> Continue</button>}
                {isRunning && <button className="btn" onClick={handleStopRun}><Square size={13} /> Stop All</button>}
                {isPaused && <button className="btn" onClick={handleResume}><PlayCircle size={13} /> Resume</button>}
                {isPaused && <button className="btn primary" onClick={handleStartRun}><Play size={13} /> New Run</button>}
                <button className="btn icon-btn" onClick={cycleTheme} title={`Theme: ${THEME_LABELS[theme]}`}><Palette size={13} /></button>
                <button className="btn icon-btn" onClick={handleRefreshMessages} title="Refresh"><RefreshCw size={13} /></button>
                <button className="btn icon-btn" onClick={() => setActiveTab(activeTab === 'settings' ? 'runs' : 'settings')} title="Settings"><Settings size={13} /></button>
              </div>
            </div>

            {/* Content */}
            {activeTab === 'settings' ? (
              <AgentSettings agent={selectedAgent} onUpdated={loadAgents} />
            ) : (
              <div className="content-split">
                {/* Runs tree */}
                <div className="runs-panel">
                  <div className="runs-panel__header">
                    <span>Runs ({runs.filter(r => !r.parent_run_id).length})</span>
                  </div>
                  <TreeView
                    items={treeRuns}
                    selectedId={runId}
                    onSelect={handleSelectRun}
                    emptyMessage="No runs yet"
                    renderIcon={(run) => <StatusDot status={run.status} />}
                    renderLabel={(run) => (
                      <span style={{ fontSize: 12 }}>
                        {formatRunDate(run.created_at)}
                      </span>
                    )}
                    renderSecondary={(run) => {
                      if (run.run_error) return <span style={{ color: 'var(--c-red)' }}>{run.run_error}</span>;
                      if (run.run_summary) return <span>{run.run_summary.slice(0, 80)}</span>;
                      const activity = runActivity[run.id];
                      if (activity) return <span>{activity.slice(0, 80)}</span>;
                      if (run.status === 'running') return <span style={{ color: 'var(--c-accent)' }}>Running...</span>;
                      if (run.last_message) return <span>{run.last_message.text.slice(0, 80)}</span>;
                      return null;
                    }}
                    renderActions={(run) =>
                      isLive(run) ? (
                        <button
                          className="btn btn--sm"
                          onClick={() => agentId && api.stopSpecificRun(agentId, run.id).then(() => { loadAgents(); api.listRuns(agentId).then(setRuns); })}
                        >
                          <Square size={10} />
                        </button>
                      ) : null
                    }
                  />
                </div>

                {/* Messages */}
                <div className="messages-area">
                  {selectedRun && isLive(selectedRun) && (
                    <div className="run-actions">
                      <StatusDot status={selectedRun.status} />
                      <span>{selectedRun.status === 'paused' ? 'Paused' : 'Running'}</span>
                      {selectedRun.status === 'paused' && (
                        <button className="btn btn--sm" onClick={handleResume}>
                          <PlayCircle size={11} /> Resume
                        </button>
                      )}
                      <button className="btn btn--sm" onClick={handleStopSelectedRun}>
                        <Square size={11} /> Stop
                      </button>
                    </div>
                  )}
                  {selectedRun ? (
                    <MessageView messages={messages} streamingText={streamingText} streamingThinking={streamingThinking} runStatus={selectedRun.status} />
                  ) : (
                    <div className="empty-state">Select a run</div>
                  )}
                  <InputBar onSend={handleSend} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismiss} />

      {showCreateModal && (
        <CreateAgentModal
          onClose={() => setShowCreateModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

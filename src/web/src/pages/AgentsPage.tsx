import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Agent, Run, MessageRecord } from '../types';
import { api } from '../api';
import { Sidebar } from '../components/Sidebar';
import { StatusBadge } from '../components/StatusBadge';
import { MessageView } from '../components/MessageView';
import { InputBar } from '../components/InputBar';
import { CreateAgentModal } from '../components/CreateAgentModal';
import '../styles/components.scss';

export function AgentsPage() {
  const { agentId, runId } = useParams();
  const navigate = useNavigate();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Refs so SSE callbacks see latest values without re-subscribing
  const agentIdRef = useRef(agentId);
  const runIdRef = useRef(runId);
  useEffect(() => { agentIdRef.current = agentId; }, [agentId]);
  useEffect(() => { runIdRef.current = runId; }, [runId]);

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

  // ── Load runs when agent changes ──

  useEffect(() => {
    if (!agentId) {
      setRuns([]);
      setMessages([]);
      return;
    }
    api.listRuns(agentId).then(setRuns);
  }, [agentId]);

  // ── Load messages when run changes ──

  useEffect(() => {
    if (!agentId || !runId) {
      setMessages([]);
      return;
    }
    api.getRunMessages(agentId, runId).then(setMessages);
  }, [agentId, runId]);

  // ── Auto-select latest run when agent changes ──

  useEffect(() => {
    if (agentId && runs.length > 0 && !runId) {
      navigate(`/agents/${agentId}/runs/${runs[0].id}`, { replace: true });
    }
  }, [agentId, runs, runId, navigate]);

  // ── SSE: live updates when an agent is selected ──

  useEffect(() => {
    if (!agentId) return;

    const es = new EventSource(`/api/agents/${agentId}/stream`);

    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        switch (data.type) {
          case 'agent_status':
            // Update this agent's status in the list
            setAgents(prev => prev.map(a =>
              a.id === data.agentId ? { ...a, status: data.status } : a,
            ));
            break;

          case 'run_complete':
            // Refresh runs list and current messages
            api.listRuns(agentIdRef.current!).then(setRuns);
            if (runIdRef.current) {
              api.getRunMessages(agentIdRef.current!, runIdRef.current).then(setMessages);
            }
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

          case 'log':
            // On tool execution logs, refresh messages for the active run
            if (data.event === 'tool.executed' && runIdRef.current) {
              api.getRunMessages(agentIdRef.current!, runIdRef.current).then(setMessages);
            }
            break;
        }
      } catch { /* ignore parse errors */ }
    };

    return () => es.close();
  }, [agentId, loadAgents]);

  // ── Actions ──

  const selectedAgent = agents.find(a => a.id === agentId) ?? null;
  const selectedRun = runs.find(r => r.id === runId) ?? null;

  async function handleStartRun() {
    if (!agentId) return;
    const result = await api.startRun(agentId);
    await loadAgents();
    const updatedRuns = await api.listRuns(agentId);
    setRuns(updatedRuns);
    navigate(`/agents/${agentId}/runs/${result.runId}`);
  }

  async function handleContinueRun() {
    if (!agentId || runs.length === 0) return;
    const latestRunId = runs[0].id;
    await api.startRun(agentId, { run_id: latestRunId });
    await loadAgents();
    const updatedRuns = await api.listRuns(agentId);
    setRuns(updatedRuns);
    navigate(`/agents/${agentId}/runs/${latestRunId}`);
  }

  async function handleStopRun() {
    if (!agentId) return;
    await api.stopRun(agentId);
    await loadAgents();
    if (runId) {
      const msgs = await api.getRunMessages(agentId, runId);
      setMessages(msgs);
    }
  }

  async function handleResume(message?: string) {
    if (!agentId) return;
    await api.resumeAgent(agentId, message || undefined);
    await loadAgents();
  }

  async function handleSend(message: string) {
    if (!agentId) return;

    console.log('[handleSend]', {
      status: selectedAgent?.status,
      runsCount: runs.length,
      latestRunId: runs[0]?.id,
      currentRunId: runId,
    });

    if (selectedAgent?.status === 'paused') {
      console.log('[handleSend] → resume');
      await handleResume(message);
      return;
    }

    if (selectedAgent?.status === 'running') {
      try {
        console.log('[handleSend] → inject');
        await api.injectMessage(agentId, message);
        return;
      } catch (err) {
        console.log('[handleSend] inject failed, falling through:', err);
      }
    }

    // Idle — continue latest run with this message, or start fresh if no runs exist
    const latestRunId = runs[0]?.id;
    const body = {
      input: message,
      ...(latestRunId ? { run_id: latestRunId } : {}),
    };
    console.log('[handleSend] → startRun', body);
    const result = await api.startRun(agentId, body);
    console.log('[handleSend] startRun result:', result);
    await loadAgents();
    const updatedRuns = await api.listRuns(agentId);
    setRuns(updatedRuns);
    // If continuing the same run, re-fetch messages since runId won't change
    if (result.runId === runId) {
      const msgs = await api.getRunMessages(agentId, runId);
      setMessages(msgs);
    }
    navigate(`/agents/${agentId}/runs/${result.runId}`);
  }

  async function handleDelete() {
    if (!agentId || !confirm('Delete this agent?')) return;
    await api.deleteAgent(agentId);
    navigate('/');
    await loadAgents();
  }

  async function handleCreated(newId: string) {
    setShowCreateModal(false);
    await loadAgents();
    navigate(`/agents/${newId}`);
  }

  function handleSelectRun(id: string) {
    if (agentId) {
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

  // ── Render ──

  const isRunning = selectedAgent?.status === 'running';
  const isPaused = selectedAgent?.status === 'paused';
  const isStopped = !isRunning && !isPaused;

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
                <h2>{selectedAgent.name}</h2>
                <StatusBadge status={selectedAgent.status} />
                <span className="panel-header__meta">{selectedAgent.type} | {selectedAgent.model}</span>
              </div>
              <div className="panel-header__actions">
                {isStopped && <button className="btn primary" onClick={handleStartRun}>Start Run</button>}
                {isStopped && runs.length > 0 && <button className="btn" onClick={handleContinueRun}>Continue</button>}
                {isRunning && <button className="btn" onClick={handleStopRun}>Stop</button>}
                {isPaused && <button className="btn" onClick={() => handleResume()}>Resume</button>}
                <button className="btn" onClick={handleRefreshMessages}>Refresh</button>
                <button className="btn danger" onClick={handleDelete}>Delete</button>
              </div>
            </div>

            {/* Content area: runs panel + messages */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
              {/* Runs list */}
              <div className="runs-panel">
                <div className="runs-panel__header">Runs ({runs.length})</div>
                <div className="runs-panel__list">
                  {runs.map(run => (
                    <div
                      key={run.id}
                      className={`run-item ${run.id === runId ? 'active' : ''}`}
                      onClick={() => handleSelectRun(run.id)}
                    >
                      <div className="run-item__trigger">{run.trigger ?? 'manual'}</div>
                      <div className="run-item__time">{new Date(run.created_at).toLocaleString()}</div>
                      {run.run_error && <div className="run-item__error">{run.run_error}</div>}
                      {run.run_summary && !run.run_error && (
                        <div className="run-item__summary" title={run.run_summary}>
                          {run.run_summary.slice(0, 80)}
                        </div>
                      )}
                    </div>
                  ))}
                  {runs.length === 0 && (
                    <div style={{ padding: '12px', color: '#8b949e', fontSize: '12px' }}>
                      No runs yet
                    </div>
                  )}
                </div>
              </div>

              {/* Messages */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {selectedRun ? (
                  <MessageView messages={messages} />
                ) : (
                  <div className="empty-state">Select a run to view messages</div>
                )}

                <InputBar onSend={handleSend} />
              </div>
            </div>
          </>
        )}
      </div>

      {showCreateModal && (
        <CreateAgentModal
          onClose={() => setShowCreateModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

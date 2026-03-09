import { useState } from 'react';
import { api } from '../api';
import { AgentForm, type AgentFormData } from './AgentForm';
import { Countdown } from './Countdown';
import type { Agent } from '../types';

interface AgentSettingsProps {
  agent: Agent;
  onUpdated: () => void;
}

export function AgentSettings({ agent, onUpdated }: AgentSettingsProps) {
  const [editing, setEditing] = useState(false);

  async function handleSubmit(data: AgentFormData) {
    try {
      await api.updateAgent(agent.id, {
        name: data.name,
        system_prompt: data.system_prompt,
        tools: data.tools,
        cwd: data.cwd || agent.cwd,
        model: data.model || agent.model,
        docker_image: data.docker_image || agent.docker_image,
        schedule: data.schedule || null,
        schedule_overlap: data.schedule_overlap,
        max_turns: data.max_turns,
        timeout_ms: data.timeout_ms,
        mounts: data.mounts,
      });
      setEditing(false);
      onUpdated();
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (editing) {
    return (
      <div className="agent-settings">
        <div className="agent-settings__form">
          <AgentForm
            initial={agent}
            onSubmit={handleSubmit}
            onCancel={() => setEditing(false)}
            submitLabel="Save"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="agent-settings">
      <div className="agent-settings__header">
        <button className="btn" onClick={() => setEditing(true)}>Edit</button>
      </div>
      <div className="agent-settings__grid">
        <Row label="Name" value={agent.name} />
        <Row label="Model" value={agent.model} />
        <Row label="Working Directory" value={agent.cwd} mono />
        <Row label="Docker Image" value={agent.docker_image} mono />
        <Row label="Bind Mounts" value={
          agent.mounts?.length > 0
            ? agent.mounts.map(m => `${m.host} -> ${m.container}${m.readonly ? ' (ro)' : ''}`).join('\n')
            : 'None'
        } pre={agent.mounts?.length > 0} />
        <Row label="Tools" value={agent.tools.join(', ')} />
        <Row label="Schedule" value={agent.schedule ?? 'None'} />
        {agent.schedule && (
          <>
            <Row label="Overlap Policy" value={agent.schedule_overlap} />
            <Row label="Next Run" value={agent.next_run ? new Date(agent.next_run).toLocaleString() : 'N/A'}>
              {agent.next_run && agent.status !== 'running' && (
                <> <Countdown targetDate={agent.next_run} /></>
              )}
            </Row>
          </>
        )}
        <Row label="Max Turns" value={String(agent.max_turns)} />
        <Row label="Timeout" value={`${agent.timeout_ms / 1000}s`} />
        <Row label="System Prompt" value={agent.system_prompt} pre />
      </div>
    </div>
  );
}

function Row({ label, value, mono, pre, children }: { label: string; value: string; mono?: boolean; pre?: boolean; children?: React.ReactNode }) {
  return (
    <div className="agent-settings__row">
      <div className="agent-settings__label">{label}</div>
      <div className={`agent-settings__value${mono ? ' mono' : ''}${pre ? ' pre' : ''}`}>{value}{children}</div>
    </div>
  );
}

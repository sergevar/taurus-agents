import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../api';
import { ToolPicker } from './ToolPicker';
import { ModelPicker } from './ModelPicker';
import type { Agent } from '../types';

export type MountEntry = { host: string; container: string; readonly?: boolean };

export interface AgentFormData {
  name: string;
  system_prompt: string;
  tools: string[];
  cwd: string;
  model: string;
  docker_image: string;
  schedule: string;
  schedule_overlap: 'skip' | 'queue' | 'kill';
  max_turns: number;
  timeout_ms: number;
  mounts: MountEntry[];
  parent_agent_id: string;
}

interface AgentFormProps {
  /** Pre-fill from existing agent (edit mode) */
  initial?: Agent;
  /** All agents for the parent selector (create mode) */
  agents?: Agent[];
  onSubmit: (data: AgentFormData) => void;
  onCancel: () => void;
  submitLabel?: string;
}

/** Build breadcrumb path for an agent: "grandparent / parent / name" */
function agentPath(agent: Agent, all: Agent[]): string {
  const parts: string[] = [];
  let cur: Agent | undefined = agent;
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parent_agent_id ? all.find(a => a.id === cur!.parent_agent_id) : undefined;
  }
  return parts.join(' \u25B8 ');
}

export function AgentForm({ initial, agents, onSubmit, onCancel, submitLabel = 'Create' }: AgentFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.system_prompt ?? 'You are a helpful agent. Today\'s date is {{date}}.');
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set(initial?.tools ?? []));
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [dockerImage, setDockerImage] = useState(initial?.docker_image ?? '');
  const [schedule, setSchedule] = useState(initial?.schedule ?? '');
  const [scheduleOverlap, setScheduleOverlap] = useState<'skip' | 'queue' | 'kill'>(initial?.schedule_overlap ?? 'skip');
  const [maxTurns, setMaxTurns] = useState<string>(initial ? String(initial.max_turns) : '');
  const [timeoutMs, setTimeoutMs] = useState<string>(initial ? String(initial.timeout_ms / 1000) : '');
  const [mounts, setMounts] = useState<MountEntry[]>(initial?.mounts ?? []);
  const [parentAgentId, setParentAgentId] = useState(initial?.parent_agent_id ?? '');
  const [defaults, setDefaults] = useState<{ model: string; docker_image: string; max_turns: number; timeout_ms: number } | null>(null);
  const [allToolNames, setAllToolNames] = useState<string[]>([]);
  const [readonlyTools, setReadonlyTools] = useState<string[]>([]);

  useEffect(() => {
    api.listTools().then(res => {
      if (!initial) {
        setSelectedTools(new Set(res.defaults.tools));
      }
      setDefaults(res.defaults);
      setAllToolNames(res.tools.map((t: { name: string }) => t.name));
      setReadonlyTools(res.defaults.readonly_tools);
    }).catch(() => {});
  }, [initial]);

  function validateMounts(): string | null {
    for (let i = 0; i < mounts.length; i++) {
      const m = mounts[i];
      if (!m.host && !m.container) continue; // empty row — will be stripped
      if (!m.host || !m.container) return `Bind mount row ${i + 1}: both host and container paths are required`;
      if (!m.host.startsWith('/')) return `Bind mount row ${i + 1}: host path must start with /`;
      if (!m.container.startsWith('/')) return `Bind mount row ${i + 1}: container path must start with /`;
    }
    return null;
  }

  function handleSubmit() {
    if (!name || !systemPrompt) {
      alert('Name and system prompt are required');
      return;
    }

    const mountError = validateMounts();
    if (mountError) {
      alert(mountError);
      return;
    }

    const resolvedMaxTurns = maxTurns !== '' ? parseInt(maxTurns, 10) : (defaults?.max_turns ?? 0);
    const resolvedTimeoutS = timeoutMs !== '' ? parseFloat(timeoutMs) : ((defaults?.timeout_ms ?? 300_000) / 1000);

    onSubmit({
      name,
      system_prompt: systemPrompt,
      tools: [...selectedTools],
      cwd: cwd || '',
      model: model || '',
      docker_image: dockerImage || '',
      schedule: schedule || '',
      schedule_overlap: scheduleOverlap,
      max_turns: resolvedMaxTurns,
      timeout_ms: resolvedTimeoutS * 1000,
      mounts: mounts.filter(m => m.host && m.container),
      parent_agent_id: parentAgentId || '',
    });
  }

  return (
    <>
      <label>Name</label>
      <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. code-reviewer" />

      {agents && agents.length > 0 && (
        <>
          <label>Parent Agent (optional)</label>
          <select value={parentAgentId} onChange={e => setParentAgentId(e.target.value)}>
            <option value="">None (top-level)</option>
            {agents
              .filter(a => a.id !== initial?.id)
              .map(a => (
                <option key={a.id} value={a.id}>{agentPath(a, agents)}</option>
              ))
            }
          </select>
        </>
      )}

      <label>System Prompt</label>
      <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} placeholder="You are a..." />

      <div className="label-with-actions">
        <label>Tools</label>
        <span className="label-actions">
          <button type="button" className="label-action-btn" onClick={() => setSelectedTools(new Set(allToolNames))}>All</button>
          <button type="button" className="label-action-btn" onClick={() => setSelectedTools(new Set(readonlyTools))}>Read-only</button>
          <button type="button" className="label-action-btn" onClick={() => setSelectedTools(new Set())}>None</button>
        </span>
      </div>
      <ToolPicker selected={selectedTools} onChange={setSelectedTools} />

      <label>Working Directory</label>
      <input type="text" value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/path/to/project" />

      <label>Model (optional)</label>
      <ModelPicker value={model} onChange={setModel} placeholder={defaults?.model} />

      <label>Docker Image (optional)</label>
      <input type="text" value={dockerImage} onChange={e => setDockerImage(e.target.value)} placeholder={defaults?.docker_image ?? ''} />

      <div className="label-with-actions">
        <label>Bind Mounts</label>
        <span className="label-actions">
          <button type="button" className="label-action-btn" onClick={() => setMounts([...mounts, { host: '', container: '', readonly: false }])}>+ Add</button>
        </span>
      </div>
      <div className="mounts-group">
        {mounts.length === 0 ? (
          <div className="field-hint">No host directories mounted</div>
        ) : (
          <table className="mounts-table">
            <thead className="mounts-table__head">
              <tr>
                <th>Host path</th>
                <th>Container path</th>
                <th>RO</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {mounts.map((m, i) => {
                const hasContent = m.host || m.container;
                const hostBad = hasContent && (!m.host || !m.host.startsWith('/'));
                const containerBad = hasContent && (!m.container || !m.container.startsWith('/'));
                return (
                <tr key={i}>
                  <td>
                    <input
                      type="text"
                      className={hostBad ? 'mount-invalid' : ''}
                      value={m.host}
                      onChange={e => { const next = [...mounts]; next[i] = { ...m, host: e.target.value }; setMounts(next); }}
                      placeholder="/host/path"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className={containerBad ? 'mount-invalid' : ''}
                      value={m.container}
                      onChange={e => { const next = [...mounts]; next[i] = { ...m, container: e.target.value }; setMounts(next); }}
                      placeholder="/container/path"
                    />
                  </td>
                  <td>
                    <label className="mount-ro">
                      <input
                        type="checkbox"
                        checked={m.readonly ?? false}
                        onChange={e => { const next = [...mounts]; next[i] = { ...m, readonly: e.target.checked }; setMounts(next); }}
                      />
                    </label>
                  </td>
                  <td>
                    <button type="button" className="mount-delete" onClick={() => setMounts(mounts.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <label>Schedule (optional)</label>
      <input
        type="text"
        value={schedule}
        onChange={e => setSchedule(e.target.value)}
        placeholder="e.g. every 5 minutes, daily at 9:00, */10 * * * *"
      />
      {schedule && (
        <div className="field-hint">Cron or shorthand. Examples: "every 5m", "daily at 14:30", "*/10 * * * *"</div>
      )}

      {schedule && (
        <>
          <label>If Already Running</label>
          <select value={scheduleOverlap} onChange={e => setScheduleOverlap(e.target.value as 'skip' | 'queue' | 'kill')}>
            <option value="skip">Skip (don't start new run)</option>
            <option value="queue">Queue (run after current finishes)</option>
            <option value="kill">Kill &amp; Restart (stop current, start new)</option>
          </select>
        </>
      )}

      <label>Max Turns</label>
      <input
        type="number"
        min="0"
        value={maxTurns}
        onChange={e => setMaxTurns(e.target.value)}
        placeholder={defaults ? String(defaults.max_turns) : '0'}
      />
      <div className="field-hint">0 = unlimited</div>

      <label>Timeout (seconds)</label>
      <input
        type="number"
        min="0"
        value={timeoutMs}
        onChange={e => setTimeoutMs(e.target.value)}
        placeholder={defaults ? String(defaults.timeout_ms / 1000) : '300'}
      />

      <div className="modal__actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={handleSubmit}>{submitLabel}</button>
      </div>
    </>
  );
}

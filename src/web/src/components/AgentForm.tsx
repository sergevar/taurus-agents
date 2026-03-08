import { useEffect, useState } from 'react';
import { api } from '../api';
import { ToolPicker } from './ToolPicker';
import type { Agent } from '../types';

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
}

interface AgentFormProps {
  /** Pre-fill from existing agent (edit mode) */
  initial?: Agent;
  onSubmit: (data: AgentFormData) => void;
  onCancel: () => void;
  submitLabel?: string;
}

export function AgentForm({ initial, onSubmit, onCancel, submitLabel = 'Create' }: AgentFormProps) {
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

  function handleSubmit() {
    if (!name || !systemPrompt) {
      alert('Name and system prompt are required');
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
    });
  }

  return (
    <>
      <label>Name</label>
      <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. code-reviewer" />

      <label>System Prompt</label>
      <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} placeholder="You are a..." />

      <label className="label-with-actions">
        Tools
        <span className="label-actions">
          <button type="button" className="label-action-btn" onClick={() => setSelectedTools(new Set(allToolNames))}>All</button>
          <button type="button" className="label-action-btn" onClick={() => setSelectedTools(new Set(readonlyTools))}>Read-only</button>
          <button type="button" className="label-action-btn" onClick={() => setSelectedTools(new Set())}>None</button>
        </span>
      </label>
      <ToolPicker selected={selectedTools} onChange={setSelectedTools} />

      <label>Working Directory</label>
      <input type="text" value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/path/to/project" />

      <label>Model (optional)</label>
      <input type="text" value={model} onChange={e => setModel(e.target.value)} placeholder={defaults?.model ?? ''} />

      <label>Docker Image (optional)</label>
      <input type="text" value={dockerImage} onChange={e => setDockerImage(e.target.value)} placeholder={defaults?.docker_image ?? ''} />

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

      <div className="modal__actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={handleSubmit}>{submitLabel}</button>
      </div>
    </>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../api';
import { ToolPicker } from './ToolPicker';
import type { Agent } from '../types';

export interface AgentFormData {
  name: string;
  type: 'observer' | 'actor';
  system_prompt: string;
  tools: string[];
  cwd: string;
  model: string;
  docker_image: string;
  schedule: string;
  schedule_overlap: 'skip' | 'queue' | 'kill';
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
  const [type, setType] = useState<'observer' | 'actor'>(initial?.type ?? 'observer');
  const [systemPrompt, setSystemPrompt] = useState(initial?.system_prompt ?? 'You are a helpful agent. Today\'s date is {{date}}.');
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set(initial?.tools ?? []));
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [dockerImage, setDockerImage] = useState(initial?.docker_image ?? '');
  const [schedule, setSchedule] = useState(initial?.schedule ?? '');
  const [scheduleOverlap, setScheduleOverlap] = useState<'skip' | 'queue' | 'kill'>(initial?.schedule_overlap ?? 'skip');
  const [defaults, setDefaults] = useState<{ model: string; docker_image: string } | null>(null);

  useEffect(() => {
    api.listTools().then(res => {
      if (!initial) {
        setSelectedTools(new Set(res.defaults.tools));
      }
      setDefaults(res.defaults);
    }).catch(() => {});
  }, [initial]);

  function handleSubmit() {
    if (!name || !systemPrompt) {
      alert('Name and system prompt are required');
      return;
    }

    onSubmit({
      name,
      type,
      system_prompt: systemPrompt,
      tools: [...selectedTools],
      cwd: cwd || '',
      model: model || '',
      docker_image: dockerImage || '',
      schedule: schedule || '',
      schedule_overlap: scheduleOverlap,
    });
  }

  return (
    <>
      <label>Name</label>
      <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. code-reviewer" />

      <label>Type</label>
      <select value={type} onChange={e => setType(e.target.value as 'observer' | 'actor')}>
        <option value="observer">Observer (read-only)</option>
        <option value="actor">Actor (can mutate)</option>
      </select>

      <label>System Prompt</label>
      <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} placeholder="You are a..." />

      <label>Tools</label>
      <ToolPicker selected={selectedTools} onChange={setSelectedTools} />

      <label>Working Directory</label>
      <input type="text" value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/path/to/project" />

      <label>Model (optional)</label>
      <input type="text" value={model} onChange={e => setModel(e.target.value)} placeholder={defaults?.model ?? ''} />

      <label>Docker Image (optional)</label>
      <input type="text" value={dockerImage} onChange={e => setDockerImage(e.target.value)} placeholder={defaults?.docker_image ?? ''} />

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

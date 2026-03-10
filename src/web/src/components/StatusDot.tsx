import { Pause } from 'lucide-react';
import type { AgentStatus, RunStatus } from '../types';

type Status = AgentStatus | RunStatus;

const COLOR_MAP: Record<Status, string> = {
  idle:      'var(--c-muted)',
  running:   'var(--c-amber)',
  paused:    'var(--c-yellow)',
  error:     'var(--c-red)',
  disabled:  'var(--c-muted)',
  completed: 'var(--c-green)',
  stopped:   'var(--c-muted)',
};

export function StatusDot({ status, size = 8, label }: { status: Status; size?: number; label?: boolean }) {
  const color = COLOR_MAP[status] ?? 'var(--c-muted)';

  if (status === 'paused') {
    return (
      <span className="status-dot-wrap" title={status}>
        <Pause size={size + 2} color={color} fill={color} />
        {label && <span className="status-dot__label">{status}</span>}
      </span>
    );
  }

  return (
    <span className="status-dot-wrap" title={status}>
      <span
        className={`status-dot${status === 'running' ? ' status-dot--running' : ''}`}
        style={{ width: size, height: size, background: color }}
      />
      {label && <span className="status-dot__label">{status}</span>}
    </span>
  );
}

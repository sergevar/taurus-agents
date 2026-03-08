import { CheckCircle2, XCircle, Loader2, StopCircle, Pause } from 'lucide-react';
import type { Run, RunStatus } from '../types';

const config: Record<RunStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  running:   { icon: Loader2,      className: 'run-status--running',   label: 'Running' },
  paused:    { icon: Pause,        className: 'run-status--paused',    label: 'Paused' },
  completed: { icon: CheckCircle2, className: 'run-status--completed', label: 'Completed' },
  error:     { icon: XCircle,      className: 'run-status--error',     label: 'Error' },
  stopped:   { icon: StopCircle,   className: 'run-status--stopped',   label: 'Stopped' },
};

export function RunStatusIcon({ run }: { run: Run }) {
  const { icon: Icon, className, label } = config[run.status] ?? config.stopped;
  return (
    <span className={`run-status ${className}`} title={label}>
      <Icon size={14} className={run.status === 'running' ? 'spin' : ''} />
    </span>
  );
}

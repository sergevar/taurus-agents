import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { Agent } from '../types';
import { StatusBadge } from './StatusBadge';
import { Countdown } from './Countdown';

interface SidebarProps {
  agents: Agent[];
  selectedId: string | null;
  onCreateClick: () => void;
}

export function Sidebar({ agents, selectedId, onCreateClick }: SidebarProps) {
  const navigate = useNavigate();

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <h1>Taurus</h1>
        <button className="btn primary" onClick={onCreateClick}><Plus size={14} /> New</button>
      </div>
      <div className="sidebar__list">
        {agents.map(agent => (
          <div
            key={agent.id}
            className={`agent-item ${agent.id === selectedId ? 'active' : ''}`}
            onClick={() => navigate(`/agents/${agent.id}`)}
          >
            <div className="agent-item__name">
              {agent.name}
              <StatusBadge status={agent.status} />
            </div>
            <div className="agent-item__meta">
              {agent.tools.join(', ')}
            </div>
            {agent.schedule && agent.next_run && agent.status !== 'running' && (
              <div className="agent-item__meta">
                Next: <Countdown targetDate={agent.next_run} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

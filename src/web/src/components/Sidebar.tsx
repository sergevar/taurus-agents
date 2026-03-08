import { useNavigate } from 'react-router-dom';
import type { Agent } from '../types';
import { StatusBadge } from './StatusBadge';

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
        <button className="btn primary" onClick={onCreateClick}>+ New</button>
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
              {agent.type} &middot; {agent.tools.join(', ')}
            </div>
            {agent.schedule && agent.next_run && (
              <div className="agent-item__meta">
                Next: {new Date(agent.next_run).toLocaleString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

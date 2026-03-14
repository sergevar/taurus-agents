import { useEffect } from 'react';
import { api } from '../api';
import { AgentForm, type AgentFormData } from './AgentForm';
import type { Agent } from '../types';

interface CreateAgentModalProps {
  agents?: Agent[];
  onClose: () => void;
  onCreated: (agentId: string) => void;
}

export function CreateAgentModal({ agents, onClose, onCreated }: CreateAgentModalProps) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);
  async function handleSubmit(data: AgentFormData) {
    const result = await api.createAgent({
      name: data.name,
      system_prompt: data.system_prompt,
      tools: data.tools,
      cwd: data.cwd || undefined,
      model: data.model || undefined,
      docker_image: data.docker_image || undefined,
      schedule: data.schedule || undefined,
      schedule_overlap: data.schedule_overlap,
      max_turns: data.max_turns,
      timeout_ms: data.timeout_ms,
      mounts: data.mounts,
      parent_agent_id: data.parent_agent_id || undefined,
    });

    if (result.error) {
      alert(result.error);
      return;
    }

    onCreated(result.id);
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal__header"><h3>Create Agent</h3></div>
        <div className="modal__body">
          <AgentForm agents={agents} onSubmit={handleSubmit} onCancel={onClose} submitLabel="Create" />
        </div>
      </div>
    </div>
  );
}

import { api } from '../api';
import { AgentForm, type AgentFormData } from './AgentForm';

interface CreateAgentModalProps {
  onClose: () => void;
  onCreated: (agentId: string) => void;
}

export function CreateAgentModal({ onClose, onCreated }: CreateAgentModalProps) {
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
        <h3>Create Agent</h3>
        <AgentForm onSubmit={handleSubmit} onCancel={onClose} submitLabel="Create" />
      </div>
    </div>
  );
}

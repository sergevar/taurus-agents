import { DataTypes, Model } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { Database } from '../index.js';

const sequelize = Database.init();

class Session extends Model {
  declare id: string;
  declare name: string | null;
  declare cwd: string;
  declare model: string;
  declare totalInputTokens: number;
  declare totalOutputTokens: number;
  declare totalCostUsd: number;
  declare thread_id: string | null;
  declare trigger: string | null;
  declare run_summary: string | null;
  declare run_error: string | null;
  declare created_at: Date;
  declare updated_at: Date;

  // ─── Static methods ───

  static async findLast(): Promise<Session | null> {
    return Session.findOne({ order: [['created_at', 'DESC']] });
  }

  static async createNew(cwd: string, model: string = 'claude-sonnet-4-20250514'): Promise<Session> {
    return Session.create({ cwd, model });
  }

  // ─── Instance methods ───

  async getMessages() {
    const { default: Message } = await import('./Message.js');
    return Message.findAll({
      where: { session_id: this.id },
      order: [['created_at', 'ASC']],
    });
  }

  async addMessage(role: string, content: any, opts?: { stopReason?: string; inputTokens?: number; outputTokens?: number }) {
    const { default: Message } = await import('./Message.js');
    const msg = await Message.create({
      session_id: this.id,
      role,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      stop_reason: opts?.stopReason ?? null,
      input_tokens: opts?.inputTokens ?? 0,
      output_tokens: opts?.outputTokens ?? 0,
    });

    // Update session token totals
    if (opts?.inputTokens || opts?.outputTokens) {
      this.totalInputTokens += opts?.inputTokens ?? 0;
      this.totalOutputTokens += opts?.outputTokens ?? 0;
      await this.save();
    }

    return msg;
  }

  toApi() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      model: this.model,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostUsd: this.totalCostUsd,
      threadId: this.thread_id,
      trigger: this.trigger,
      runSummary: this.run_summary,
      runError: this.run_error,
      createdAt: this.created_at,
      updatedAt: this.updated_at,
    };
  }
}

Session.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: uuidv4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    cwd: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    model: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'claude-sonnet-4-20250514',
    },
    totalInputTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'total_input_tokens',
    },
    totalOutputTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'total_output_tokens',
    },
    totalCostUsd: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
      field: 'total_cost_usd',
    },
    thread_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    trigger: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    run_summary: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    run_error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'Sessions',
    timestamps: true,
    underscored: true,
  }
);

export default Session;

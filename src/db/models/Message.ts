import { DataTypes, Model } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { Database } from '../index.js';
import type { ChatMessage } from '../../core/types.js';

const sequelize = Database.init();

class Message extends Model {
  declare id: string;
  declare run_id: string;
  declare role: string;
  declare content: any;
  declare stop_reason: string | null;
  declare input_tokens: number;
  declare output_tokens: number;
  declare created_at: Date;

  toChatMLMessage(): ChatMessage {
    return {
      role: this.role as 'user' | 'assistant',
      content: this.content,
    };
  }

  toApi() {
    const { id, run_id, role, content, stop_reason, input_tokens, output_tokens, created_at } = this;
    return { id, run_id, role, content, stop_reason, input_tokens, output_tokens, created_at };
  }
}

Message.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: uuidv4,
      primaryKey: true,
    },
    run_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    role: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    content: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    stop_reason: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    input_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    output_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'Messages',
    timestamps: true,
    underscored: true,
    updatedAt: false,
  }
);

export default Message;

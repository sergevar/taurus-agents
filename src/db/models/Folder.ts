import { DataTypes, Model } from 'sequelize';
import { Database } from '../index.js';
import { ROOT_FOLDER_ID } from '../../threads/types.js';

const sequelize = Database.init();

class Folder extends Model {
  declare id: string;
  declare name: string;
  declare parent_id: string | null;
  declare created_at: Date;
  declare updated_at: Date;

  static async seedRoot(): Promise<void> {
    await Folder.findOrCreate({
      where: { id: ROOT_FOLDER_ID },
      defaults: { id: ROOT_FOLDER_ID, name: 'root', parent_id: null },
    });
  }

  static async getTree(): Promise<Folder[]> {
    return Folder.findAll({ order: [['name', 'ASC']] });
  }

  toApi() {
    return {
      id: this.id,
      name: this.name,
      parentId: this.parent_id,
      createdAt: this.created_at,
      updatedAt: this.updated_at,
    };
  }
}

Folder.init(
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    parent_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'Folders',
    timestamps: true,
    underscored: true,
  }
);

export default Folder;

import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, Link } from 'lucide-react';
import { fileApi } from './api';
import type { FileEntry } from './types';

interface TreeNode extends FileEntry {
  path: string;
  children?: TreeNode[];
  loaded?: boolean;
  expanded?: boolean;
}

interface Props {
  agentId: string;
  rootPath: string;
  selectedPath?: string;
  dirtyPaths?: Set<string>;
  onSelect: (path: string) => void;
}

export function FileTree({ agentId, rootPath, selectedPath, dirtyPaths, onSelect }: Props) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load the root directory on mount or when rootPath changes
  useEffect(() => {
    loadDir(rootPath).then(entries => {
      setRoots(entries);
      setError(null);
    }).catch(err => setError(err.message));
  }, [agentId, rootPath]);

  async function loadDir(dirPath: string): Promise<TreeNode[]> {
    const listing = await fileApi.listDir(agentId, dirPath);
    return listing.entries.map(entry => ({
      ...entry,
      path: `${dirPath === '/' ? '' : dirPath}/${entry.name}`,
    }));
  }

  const toggleDir = useCallback(async (node: TreeNode) => {
    if (node.expanded) {
      // Collapse
      node.expanded = false;
      setRoots([...roots]);
      return;
    }

    if (!node.loaded) {
      try {
        node.children = await loadDir(node.path);
        node.loaded = true;
      } catch {
        node.children = [];
        node.loaded = true;
      }
    }
    node.expanded = true;
    setRoots([...roots]);
  }, [roots, agentId]);

  if (error) {
    return <div className="fb-tree__error">{error}</div>;
  }

  return (
    <div className="fb-tree">
      <ul className="fb-tree__list">
        {roots.map(node => (
          <TreeNodeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            dirtyPaths={dirtyPaths}
            onSelect={onSelect}
            onToggle={toggleDir}
          />
        ))}
      </ul>
    </div>
  );
}

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  selectedPath?: string;
  dirtyPaths?: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (node: TreeNode) => void;
}

function TreeNodeRow({ node, depth, selectedPath, dirtyPaths, onSelect, onToggle }: TreeNodeRowProps) {
  const isDir = node.type === 'dir';
  const isSelected = node.path === selectedPath;
  const isDirty = !isDir && dirtyPaths?.has(node.path);

  const handleClick = () => {
    if (isDir) {
      onToggle(node);
    } else {
      onSelect(node.path);
    }
  };

  return (
    <>
      <li
        className={`fb-tree__item ${isSelected ? 'fb-tree__item--selected' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={handleClick}
      >
        <span className="fb-tree__icon">
          {isDir ? (
            node.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span style={{ width: 14 }} />
          )}
        </span>
        <span className="fb-tree__icon">
          {isDir ? (
            node.expanded ? <FolderOpen size={14} /> : <Folder size={14} />
          ) : node.type === 'symlink' ? (
            <Link size={14} />
          ) : (
            <File size={14} />
          )}
        </span>
        <span className={`fb-tree__name${isDirty ? ' fb-tree__name--dirty' : ''}`}>{node.name}</span>
      </li>
      {isDir && node.expanded && node.children?.map(child => (
        <TreeNodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          dirtyPaths={dirtyPaths}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

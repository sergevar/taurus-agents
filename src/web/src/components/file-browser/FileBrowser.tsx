import { useState, useCallback, type KeyboardEvent } from 'react';
import { FileTree } from './FileTree';
import { FileEditor } from './FileEditor';
import './file-browser.scss';

interface Props {
  agentId: string;
}

export function FileBrowser({ agentId }: Props) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [rootPath, setRootPath] = useState('/workspace');
  const [pathInput, setPathInput] = useState('/workspace');

  const handleDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths(prev => {
      const next = new Set(prev);
      if (dirty) next.add(path); else next.delete(path);
      return next.size !== prev.size ? next : prev;
    });
  }, []);

  function handlePathSubmit() {
    const p = pathInput.trim() || '/workspace';
    setRootPath(p);
  }

  function handlePathKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handlePathSubmit();
  }

  return (
    <div className="fb">
      {/* Left: file tree */}
      <div className="fb__tree-pane">
        <div className="fb__tree-header">
          <input
            className="fb__path-input"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onBlur={handlePathSubmit}
            onKeyDown={handlePathKeyDown}
            spellCheck={false}
          />
        </div>
        <FileTree
          agentId={agentId}
          rootPath={rootPath}
          selectedPath={selectedFile ?? undefined}
          dirtyPaths={dirtyPaths}
          onSelect={(path) => setSelectedFile(path)}
        />
      </div>

      {/* Right: editor */}
      <div className="fb__right-pane">
        <div className="fb__content">
          {selectedFile ? (
            <FileEditor agentId={agentId} filePath={selectedFile} onDirtyChange={handleDirtyChange} />
          ) : (
            <div className="fb__empty">Select a file to edit</div>
          )}
        </div>
      </div>
    </div>
  );
}

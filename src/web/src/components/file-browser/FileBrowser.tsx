import { useState } from 'react';
import { FileTree } from './FileTree';
import { FileEditor } from './FileEditor';
import './file-browser.scss';

interface Props {
  agentId: string;
}

export function FileBrowser({ agentId }: Props) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  return (
    <div className="fb">
      {/* Left: file tree */}
      <div className="fb__tree-pane">
        <div className="fb__tree-header">Files</div>
        <FileTree
          agentId={agentId}
          selectedPath={selectedFile ?? undefined}
          onSelect={(path) => setSelectedFile(path)}
        />
      </div>

      {/* Right: editor */}
      <div className="fb__right-pane">
        <div className="fb__content">
          {selectedFile ? (
            <FileEditor agentId={agentId} filePath={selectedFile} />
          ) : (
            <div className="fb__empty">Select a file to edit</div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { FileTree } from './FileTree';
import { FileEditor } from './FileEditor';
import { Terminal } from './Terminal';
import { FileCode, TerminalSquare } from 'lucide-react';
import './file-browser.scss';

type RightPane = 'editor' | 'terminal';

interface Props {
  agentId: string;
}

export function FileBrowser({ agentId }: Props) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [rightPane, setRightPane] = useState<RightPane>('editor');

  return (
    <div className="fb">
      {/* Left: file tree */}
      <div className="fb__tree-pane">
        <div className="fb__tree-header">Files</div>
        <FileTree
          agentId={agentId}
          selectedPath={selectedFile ?? undefined}
          onSelect={(path) => {
            setSelectedFile(path);
            setRightPane('editor');
          }}
        />
      </div>

      {/* Right: editor or terminal */}
      <div className="fb__right-pane">
        <div className="fb__tabs">
          <button
            className={`fb__tab ${rightPane === 'editor' ? 'fb__tab--active' : ''}`}
            onClick={() => setRightPane('editor')}
          >
            <FileCode size={13} /> Editor
          </button>
          <button
            className={`fb__tab ${rightPane === 'terminal' ? 'fb__tab--active' : ''}`}
            onClick={() => setRightPane('terminal')}
          >
            <TerminalSquare size={13} /> Terminal
          </button>
        </div>

        <div className="fb__content">
          {rightPane === 'editor' ? (
            selectedFile ? (
              <FileEditor agentId={agentId} filePath={selectedFile} />
            ) : (
              <div className="fb__empty">Select a file to edit</div>
            )
          ) : (
            <Terminal agentId={agentId} />
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { fileApi } from './api';

interface Props {
  agentId: string;
  filePath: string;
}

// Map file extensions to Monaco language IDs
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml',
  xml: 'xml', svg: 'xml',
  sql: 'sql',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
};

function detectLanguage(filePath: string): string {
  const name = filePath.split('/').pop()?.toLowerCase() || '';

  // Special filenames
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === '.env' || name.startsWith('.env.')) return 'ini';

  const ext = name.split('.').pop() || '';
  return EXT_TO_LANG[ext] || 'plaintext';
}

export function FileEditor({ agentId, filePath }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<any>(null);

  // Load file content
  useEffect(() => {
    setLoading(true);
    setError(null);
    fileApi.readFile(agentId, filePath).then(data => {
      setContent(data.content);
      setSavedContent(data.content);
      setLoading(false);
    }).catch(err => {
      setError(err.message);
      setLoading(false);
    });
  }, [agentId, filePath]);

  const handleSave = useCallback(async () => {
    if (content === null || saving) return;
    setSaving(true);
    try {
      await fileApi.writeFile(agentId, filePath, content);
      setSavedContent(content);
    } catch (err: any) {
      setError(err.message);
    }
    setSaving(false);
  }, [agentId, filePath, content, saving]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    // Cmd/Ctrl+S to save
    editor.addCommand(
      // Monaco.KeyMod.CtrlCmd | Monaco.KeyCode.KeyS
      2048 | 49, // CtrlCmd=2048, KeyS=49
      () => handleSave(),
    );
  };

  const isDirty = content !== savedContent;

  if (loading) {
    return <div className="fb-editor__status">Loading...</div>;
  }

  if (error) {
    return <div className="fb-editor__status fb-editor__status--error">{error}</div>;
  }

  return (
    <div className="fb-editor">
      <div className="fb-editor__toolbar">
        <span className="fb-editor__path">{filePath}</span>
        {isDirty && <span className="fb-editor__dirty">modified</span>}
        <button
          className="btn btn--sm"
          onClick={handleSave}
          disabled={!isDirty || saving}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      <div className="fb-editor__monaco">
        <Editor
          value={content ?? ''}
          language={detectLanguage(filePath)}
          theme="vs-dark"
          onChange={(val) => setContent(val ?? '')}
          onMount={handleMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "'SF Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, monospace",
            scrollBeyondLastLine: false,
            renderLineHighlight: 'line',
            lineNumbers: 'on',
            tabSize: 2,
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

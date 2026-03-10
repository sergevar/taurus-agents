export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

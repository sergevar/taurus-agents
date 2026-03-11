import { posix } from 'node:path';

/**
 * FileTracker — tracks which files have been read and their mtime at read time.
 *
 * Shared between Read and Edit/Write tools to enforce freshness:
 * - Edit/Write must read a file before modifying it
 * - If the file changed since last read, must re-read first
 *
 * Paths are normalized (posix.normalize) so that ./foo, foo, and /workspace/./foo
 * all resolve to the same key.
 */
export class FileTracker {
  private readFiles = new Map<string, number>(); // normalized path → mtime at read time

  private norm(p: string): string { return posix.normalize(p); }

  /** Record that a file was read, with its current mtime. */
  markRead(filePath: string, mtime: number): void {
    this.readFiles.set(this.norm(filePath), mtime);
  }

  /** Update mtime after a successful write/edit (so subsequent edits don't require re-read). */
  updateMtime(filePath: string, mtime: number): void {
    this.readFiles.set(this.norm(filePath), mtime);
  }

  /** Check if a file is safe to edit. Returns null if OK, or an error message. */
  checkFreshness(filePath: string, currentMtime: number): string | null {
    const readMtime = this.readFiles.get(this.norm(filePath));
    if (readMtime === undefined) {
      return `File has not been read yet. Read it first before editing.`;
    }
    if (readMtime !== 0 && currentMtime !== readMtime) {
      return `File has changed since last read. Re-read it before editing.`;
    }
    return null;
  }
}

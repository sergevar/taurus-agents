/**
 * FileTracker — tracks which files have been read and their mtime at read time.
 *
 * Shared between Read and Edit/Write tools to enforce freshness:
 * - Edit/Write must read a file before modifying it
 * - If the file changed since last read, must re-read first
 */
export class FileTracker {
  private readFiles = new Map<string, number>(); // path → mtime at read time

  /** Record that a file was read, with its current mtime. */
  markRead(filePath: string, mtime: number): void {
    this.readFiles.set(filePath, mtime);
  }

  /** Update mtime after a successful write/edit (so subsequent edits don't require re-read). */
  updateMtime(filePath: string, mtime: number): void {
    if (this.readFiles.has(filePath)) {
      this.readFiles.set(filePath, mtime);
    }
  }

  /** Check if a file is safe to edit. Returns null if OK, or an error message. */
  checkFreshness(filePath: string, currentMtime: number): string | null {
    const readMtime = this.readFiles.get(filePath);
    if (readMtime === undefined) {
      return `File has not been read yet. Read it first before editing.`;
    }
    if (currentMtime !== readMtime) {
      return `File has changed since last read. Re-read it before editing.`;
    }
    return null;
  }
}

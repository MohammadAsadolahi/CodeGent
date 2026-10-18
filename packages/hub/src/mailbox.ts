interface Entry {
  at: number
  data: string
  terminal: boolean
}

/**
 * Holds serialized events for editors that are momentarily offline (a window reload, a
 * reconnect). Bounded in both age and count; when full, progress events are dropped before
 * terminal ones, because a lost `completed`/`failed` is the only loss that stalls a run.
 */
export class Mailbox {
  private readonly boxes = new Map<string, Entry[]>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxPerEditor: number,
    private readonly now: () => number = Date.now
  ) {}

  add(editorId: string, data: string, terminal: boolean): void {
    this.prune(editorId)
    let box = this.boxes.get(editorId)
    if (!box) {
      box = []
      this.boxes.set(editorId, box)
    }
    box.push({ at: this.now(), data, terminal })
    while (box.length > this.maxPerEditor) {
      const droppable = box.findIndex((entry) => !entry.terminal)
      box.splice(droppable === -1 ? 0 : droppable, 1)
    }
  }

  /** Returns and removes everything still fresh for this editor, oldest first. */
  drain(editorId: string): string[] {
    this.prune(editorId)
    const box = this.boxes.get(editorId) ?? []
    this.boxes.delete(editorId)
    return box.map((entry) => entry.data)
  }

  size(editorId: string): number {
    this.prune(editorId)
    return this.boxes.get(editorId)?.length ?? 0
  }

  /** Drops expired entries for every editor (called from the heartbeat tick). */
  sweep(): void {
    for (const editorId of [...this.boxes.keys()]) this.prune(editorId)
  }

  private prune(editorId: string): void {
    const box = this.boxes.get(editorId)
    if (!box) return
    const cutoff = this.now() - this.ttlMs
    const fresh = box.filter((entry) => entry.at >= cutoff)
    if (fresh.length === 0) this.boxes.delete(editorId)
    else this.boxes.set(editorId, fresh)
  }
}

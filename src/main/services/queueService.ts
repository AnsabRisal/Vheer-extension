/**
 * Queue service — owns the queue state machine and its persistence.
 *
 * The full queue is written to `<project>/queue.json` after EVERY transition.
 * That single file is what makes resume-after-crash work:
 *   - On startup the engine starts from the first unfinished shot.
 *   - Shots already `completed` / `approved` are never regenerated.
 *   - A shot left as `generating` by a killed process is reset to `waiting`
 *     and simply re-runs.
 *
 * This service is purely stateful — the actual browser automation lives in
 * the automation engine, which reads `nextPending()` and reports back through
 * `updateShot()`.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { QUEUE_FILE } from '../../shared/constants'
import type { QueueState, QueueStatus, Shot, ShotStatus } from '../../shared/types'
import { ProjectService } from './projectService'
import { readPromptFile } from './promptReader'
import { errorLog, generationLog } from './logService'

type QueueListener = (state: QueueState) => void

export class QueueService {
  private state: QueueState = this.emptyState('', '')
  private listeners = new Set<QueueListener>()
  private lastEtaTotalMs = 0
  private lastEtaDone = 0

  constructor(private projects: ProjectService) {}

  private emptyState(projectId: string, projectName: string): QueueState {
    return {
      projectId,
      projectName,
      shots: [],
      currentShotNumber: null,
      status: 'idle',
      stats: { waiting: 0, generating: 0, completed: 0, failed: 0, approved: 0 },
      etaSeconds: null,
      error: null
    }
  }

  /** Subscribe to queue snapshots (the IPC layer forwards these to the UI). */
  onUpdate(listener: QueueListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.clone()
    for (const listener of this.listeners) listener(snapshot)
  }

  private clone(): QueueState {
    return {
      ...this.state,
      shots: this.state.shots.map((s) => ({ ...s })),
      stats: { ...this.state.stats }
    }
  }

  private queueFile(): string {
    return join(this.state.projectId ? this.getRoot() : '', QUEUE_FILE)
  }

  private getRoot(): string {
    return this.projects.get(this.state.projectId).root
  }

  /** Absolute path to this project's Images/ folder (used by the engine). */
  imagesDir(): string {
    return join(this.getRoot(), 'Images')
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Parse the project's prompt file and merge in the last persisted queue
   * so completed shots survive restarts. Resets the current run state.
   */
  async loadForProject(projectId: string): Promise<QueueState> {
    const meta = this.projects.get(projectId)
    const { shots, warnings } = await readPromptFile(meta.promptsFile)
    if (warnings.length) {
      generationLog.warn(`Prompt file warnings for ${meta.name}: ${warnings.join('; ')}`)
    }

    const persisted = this.readPersisted(meta.root)
    for (const shot of shots) {
      const prev = persisted.get(shot.number)
      if (!prev) continue
      // Restore finished shots; reset interrupted ones.
      if (prev.status === 'completed' || prev.status === 'approved' || prev.status === 'failed') {
        shot.status = prev.status
        shot.imagePath = prev.imagePath
        shot.retryCount = prev.retryCount
      }
    }

    this.state = this.emptyState(projectId, meta.name)
    this.state.shots = shots
    this.recomputeStats()
    this.state.currentShotNumber = null
    this.state.status = 'idle'
    this.state.error = null
    this.persist()
    this.emit()
    return this.clone()
  }

  private readPersisted(root: string): Map<number, Shot> {
    const file = join(root, QUEUE_FILE)
    if (!existsSync(file)) return new Map()
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as { shots?: Shot[] }
      const map = new Map<number, Shot>()
      for (const s of raw.shots ?? []) {
        if (s && typeof s.number === 'number') map.set(s.number, s)
      }
      return map
    } catch (err) {
      errorLog.warn(`Could not read ${QUEUE_FILE}: ${(err as Error).message}`)
      return new Map()
    }
  }

  // -------------------------------------------------------------------------
  // Read operations (used by the engine)
  // -------------------------------------------------------------------------

  getState(): QueueState {
    return this.clone()
  }

  getShot(number: number): Shot | undefined {
    return this.state.shots.find((s) => s.number === number)
  }

  /** First shot that still needs work: waiting, or a leftover generating shot. */
  nextPending(): Shot | null {
    return (
      this.state.shots.find((s) => s.status === 'waiting' || s.status === 'generating') ??
      null
    )
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  setStatus(status: QueueStatus, error: string | null = null): void {
    this.state.status = status
    this.state.error = error
    this.persist()
    this.emit()
  }

  setCurrent(shotNumber: number | null): void {
    this.state.currentShotNumber = shotNumber
    this.persist()
    this.emit()
  }

  /** Transition a single shot and recompute aggregate stats. */
  updateShot(number: number, patch: Partial<Pick<Shot, 'status' | 'imagePath' | 'retryCount'>>): void {
    const shot = this.getShot(number)
    if (!shot) return
    if (patch.status !== undefined) shot.status = patch.status
    if (patch.imagePath !== undefined) shot.imagePath = patch.imagePath
    if (patch.retryCount !== undefined) shot.retryCount = patch.retryCount
    this.recomputeStats()
    this.persist()
    this.emit()
  }

  /** Record shot completion time so the ETA can be estimated. */
  noteElapsed(ms: number): void {
    this.lastEtaTotalMs += ms
    this.lastEtaDone += 1
    const remaining = this.state.shots.filter(
      (s) => s.status === 'waiting' || s.status === 'generating'
    ).length
    const avg = this.lastEtaDone > 0 ? this.lastEtaTotalMs / this.lastEtaDone : 0
    this.state.etaSeconds =
      remaining > 0 && avg > 0 ? Math.round((avg * remaining) / 1000) : null
  }

  resetEta(): void {
    this.lastEtaTotalMs = 0
    this.lastEtaDone = 0
    this.state.etaSeconds = null
  }

  /** Gallery action: mark a finished shot as approved. */
  approve(number: number): void {
    const shot = this.getShot(number)
    if (shot && shot.status === 'completed') {
      shot.status = 'approved'
      this.recomputeStats()
      this.persist()
      this.emit()
    }
  }

  /** Manually re-run a shot. The old image stays (download manager renames). */
  regenerate(number: number): void {
    const shot = this.getShot(number)
    if (!shot) return
    shot.status = 'waiting'
    shot.retryCount = 0
    this.recomputeStats()
    this.persist()
    this.emit()
  }

  private recomputeStats(): void {
    const stats = { waiting: 0, generating: 0, completed: 0, failed: 0, approved: 0 }
    for (const s of this.state.shots) stats[s.status] += 1
    this.state.stats = stats
  }

  private persist(): void {
    if (!this.state.projectId) return
    try {
      const file = this.queueFile()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(
        file,
        JSON.stringify(
          { version: 1, projectId: this.state.projectId, shots: this.state.shots },
          null,
          2
        ),
        'utf-8'
      )
    } catch (err) {
      errorLog.warn(`Could not persist queue: ${(err as Error).message}`)
    }
  }
}

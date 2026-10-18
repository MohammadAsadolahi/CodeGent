import { useEffect, useState } from 'preact/hooks'
import type { ToExtension, ToWebview, UiState } from '../src/ui/protocol'

interface VsCodeApi {
  postMessage(message: ToExtension): void
  getState<T>(): T | undefined
  setState<T>(state: T): void
}

declare function acquireVsCodeApi(): VsCodeApi

const vscode: VsCodeApi = acquireVsCodeApi()

export const post = (message: ToExtension): void => vscode.postMessage(message)

interface Persisted {
  draft: string
  history?: boolean
}

export const loadPersisted = (): Persisted => vscode.getState<Persisted>() ?? { draft: '' }
export const savePersisted = (value: Persisted): void => vscode.setState(value)

/** The latest state pushed by the extension (undefined until the first message arrives). */
export const useUiState = (): UiState | undefined => {
  const [state, setState] = useState<UiState | undefined>(undefined)
  useEffect(() => {
    const onMessage = (event: MessageEvent<ToWebview>) => {
      if (event.data?.type === 'state') setState(event.data.state)
    }
    window.addEventListener('message', onMessage)
    post({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])
  return state
}

/** A clock that ticks every second while `active`, for elapsed-time labels. */
export const useNow = (active: boolean): number => {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

export const formatAgo = (timestamp: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

import type React from 'react'
import type { Channel } from './channel.js'

/** Host-owned values supplied to a full-screen TUI contribution. */
export interface TuiSceneProps {
  readonly React: typeof React
  readonly ui: typeof import('../ui.js')
  readonly channel: Channel
  close(): void
}

export interface TuiSceneDescriptor {
  readonly id: string
  readonly title?: string
  readonly component: React.ComponentType<TuiSceneProps>
}

export interface TuiSceneSelection {
  readonly active: TuiSceneDescriptor | undefined
  open(id: string): boolean
  close(): void
  subscribe(listener: () => void): () => void
}

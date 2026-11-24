import type { ProjectState } from '../types';

export type PageKey = 'board' | 'wires' | 'projectors' | 'guide' | 'preview';

export interface AppContext {
  state: ProjectState;
  params: Record<string, string>;
  update: (mutator: (draft: ProjectState) => void, options?: { reroute?: boolean; silent?: boolean }) => void;
  saveNow: () => Promise<void>;
  resetDemo: () => void;
  go: (page: PageKey, params?: Record<string, string>) => void;
}

export interface PageHandle {
  destroy?: () => void;
}

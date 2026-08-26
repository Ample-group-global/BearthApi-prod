export interface ExportState {
  status: 'running' | 'done' | 'error';
  progress: number;
  total: number;
  phase: string;
  error?: string;
  // Bumped on every progress update — lets the start-export route tell a
  // genuinely stuck job apart from one whose serverless invocation was
  // killed outright (e.g. Vercel's execution-time limit). A hard kill never
  // runs the route's own .finally() cleanup, so without this the "running"
  // flag would stay stuck forever and permanently block every future export
  // attempt for the whole app, not just this job.
  lastUpdatedAt: number;
}

export interface RefreshCidState {
  status: 'running' | 'done' | 'error';
  progress: number;
  total: number;
  resolved: number;
  skipped: number;
  phase: string;
  error?: string;
}

export interface PreviewState {
  status: 'running' | 'done' | 'error';
  progress: number;
  total: number;
  phase: string;
  validCount: number;
  invalidItems: Array<{ edition: number; reason: string }>;
  error?: string;
}

export const exportMeta = {
  running: false,
  jobs: new Map<string, ExportState>(),
};

export const refreshCidMeta = {
  running: false,
  jobs: new Map<string, RefreshCidState>(),
};

export const previewMeta = {
  jobs: new Map<string, PreviewState & { dir: string }>(),
};

export const zipRegistry = new Map<string, { bucket: string; zipKey: string }>();

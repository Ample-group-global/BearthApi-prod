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
  // Present when this state is one slice of a range-parallel export (see
  // export.ts's fan-out path) — identifies which edition range this
  // specific invocation owns, so concurrent slices for the same job don't
  // collide with each other's "already running" lock.
  jobId?: string;
  rangeStart?: number;
  rangeEnd?: number;
}

export interface RefreshCidState {
  status: 'running' | 'done' | 'error';
  progress: number;
  total: number;
  resolved: number;
  skipped: number;
  phase: string;
  error?: string;
  jobId?: string;
  lastUpdatedAt?: number;
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
  jobs: new Map<string, ExportState>(),
  // Separate from `jobs`/`running` (the single-shot export lock) entirely —
  // the range-parallel fan-out path (export.ts's /range route) tracks each
  // concurrent slice here, keyed by `${jobId}:${rangeStart}-${rangeEnd}`,
  // so N slices for the same job never collide with each other's lock, and
  // the existing single-shot flow's locking is untouched.
  rangeSlices: new Map<string, ExportState>(),
};

export const refreshCidMeta = {
  jobs: new Map<string, RefreshCidState>(),
};

export const previewMeta = {
  jobs: new Map<string, PreviewState & { dir: string }>(),
};

export const zipRegistry = new Map<string, { bucket: string; zipKey: string }>();

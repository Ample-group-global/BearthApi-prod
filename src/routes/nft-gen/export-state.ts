export interface ExportState {
  status: 'running' | 'done' | 'error';
  progress: number;
  total: number;
  phase: string;
  error?: string;
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

/** Main-thread client for depthWorker.ts. Lazily spawns one worker and reuses it. */
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface DepthMap {
  /** Nearness 0..255 (255 = nearest), row-major, top row first. */
  data: Uint8Array;
  width: number;
  height: number;
  device: string;
}

interface Pending {
  resolve(d: DepthMap): void;
  reject(e: Error): void;
  onStatus?: (msg: string) => void;
}

export class DepthEstimator {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  estimate(image: ImageData, onStatus?: (msg: string) => void): Promise<DepthMap> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<DepthMap>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStatus });
      const pixels = image.data.buffer as ArrayBuffer;
      const req: WorkerRequest = { type: 'estimate', id, width: image.width, height: image.height, pixels };
      worker.postMessage(req, [pixels]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('Depth estimator was disposed'));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./depthWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    w.onerror = (ev: ErrorEvent) => {
      ev.preventDefault();
      console.error('[DepthEstimator] worker error', ev);
      w.terminate();
      if (this.worker === w) this.worker = null;
      this.failAll(new Error(`Depth worker crashed${ev.message ? `: ${ev.message}` : ''}`));
    };
    w.onmessageerror = () => this.failAll(new Error('Depth worker sent an unreadable message'));
    this.worker = w;
    return w;
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case 'status':
        p.onStatus?.(msg.message);
        break;
      case 'progress': {
        const pct = Math.max(0, Math.min(100, Math.round(msg.progress)));
        const mb = (b: number) => (b / 1048576).toFixed(1);
        const size = msg.total > 0 ? ` (${mb(msg.loaded)} / ${mb(msg.total)} MB)` : '';
        p.onStatus?.(`Downloading depth model… ${pct}%${size}`);
        break;
      }
      case 'result':
        this.pending.delete(msg.id);
        p.resolve({ data: new Uint8Array(msg.depth), width: msg.width, height: msg.height, device: msg.device });
        break;
      case 'error':
        this.pending.delete(msg.id);
        p.reject(new Error(msg.message));
        break;
    }
  }

  private failAll(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }
}

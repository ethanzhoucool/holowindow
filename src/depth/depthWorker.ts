/// <reference lib="webworker" />
/**
 * Depth estimation worker. Runs Depth Anything V2 (small) through transformers.js,
 * preferring WebGPU and falling back to WASM. The pipeline is created once and reused.
 */
import { env, pipeline, RawImage, type ProgressInfo } from '@huggingface/transformers';
import { postProcessDepth } from './depthPost';
import { DEPTH_MODEL_ID, type WorkerRequest, type WorkerResponse } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

env.allowLocalModels = false;
env.allowRemoteModels = true;

type Device = 'webgpu' | 'wasm';
type DepthPipe = Awaited<ReturnType<typeof pipeline<'depth-estimation'>>>;

interface Loaded {
  pipe: DepthPipe;
  device: Device;
}

let loading: Promise<Loaded> | null = null;
/** id of the request currently driving model-download progress messages. */
let progressId = 0;
let webgpuBroken = false;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

interface MinimalGpu {
  requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null>;
}

async function webgpuDtype(): Promise<'fp16' | 'fp32' | null> {
  if (webgpuBroken) return null;
  const gpu = (navigator as unknown as { gpu?: MinimalGpu }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    return adapter.features.has('shader-f16') ? 'fp16' : 'fp32';
  } catch {
    return null;
  }
}

let lastPct = -1;

function onProgress(info: ProgressInfo): void {
  if (info.status === 'progress_total') {
    const pct = Math.floor(info.progress);
    if (pct === lastPct) return;
    lastPct = pct;
    post({ type: 'progress', id: progressId, progress: info.progress, loaded: info.loaded, total: info.total });
  }
}

async function create(): Promise<Loaded> {
  const dtype = await webgpuDtype();
  if (dtype) {
    try {
      post({ type: 'status', id: progressId, message: 'Loading depth model (WebGPU)…' });
      const pipe = await pipeline('depth-estimation', DEPTH_MODEL_ID, {
        device: 'webgpu',
        dtype,
        progress_callback: onProgress,
      });
      return { pipe, device: 'webgpu' };
    } catch (err) {
      console.warn('[depthWorker] WebGPU pipeline failed, falling back to WASM', err);
      webgpuBroken = true;
    }
  }
  post({ type: 'status', id: progressId, message: 'Loading depth model (CPU/WASM)…' });
  const pipe = await pipeline('depth-estimation', DEPTH_MODEL_ID, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: onProgress,
  });
  return { pipe, device: 'wasm' };
}

function getPipeline(): Promise<Loaded> {
  if (!loading) {
    loading = create().catch((err: unknown) => {
      loading = null; // allow a retry on the next image
      throw err;
    });
  }
  return loading;
}

async function infer(pipe: DepthPipe, img: RawImage): Promise<{ data: Float32Array; width: number; height: number }> {
  const out = await pipe(img);
  let t = out.predicted_depth;
  if (t.type !== 'float32') t = t.to('float32');
  const [height, width] = t.dims.slice(-2);
  return { data: t.data as Float32Array, width, height };
}

async function estimate(req: WorkerRequest): Promise<void> {
  const { id, width, height } = req;
  progressId = id;
  let loaded: Loaded;
  try {
    loaded = await getPipeline();
  } catch (err) {
    throw new Error(`Failed to load depth model (${messageOf(err)}). Check your connection and try again.`);
  }

  post({ type: 'status', id, message: `Estimating depth (${loaded.device === 'webgpu' ? 'GPU' : 'CPU'})…` });
  const img = new RawImage(new Uint8ClampedArray(req.pixels), width, height, 4);

  let result: { data: Float32Array; width: number; height: number };
  try {
    result = await infer(loaded.pipe, img);
  } catch (err) {
    if (loaded.device !== 'webgpu') throw err;
    // Some GPUs/drivers fail at inference time — retry once on WASM.
    console.warn('[depthWorker] WebGPU inference failed, retrying on WASM', err);
    webgpuBroken = true;
    void loaded.pipe.dispose().catch(() => {});
    loading = null;
    loaded = await getPipeline();
    post({ type: 'status', id, message: 'Estimating depth (CPU)…' });
    result = await infer(loaded.pipe, img);
  }

  const depth = postProcessDepth(result.data, result.width, result.height, { normalize: true });
  post(
    { type: 'result', id, width: result.width, height: result.height, depth: depth.buffer as ArrayBuffer, device: loaded.device },
    [depth.buffer as ArrayBuffer],
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Process requests strictly one at a time.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req?.type !== 'estimate') return;
  queue = queue.then(() =>
    estimate(req).catch((err: unknown) => {
      console.error('[depthWorker]', err);
      post({ type: 'error', id: req.id, message: messageOf(err) });
    }),
  );
};

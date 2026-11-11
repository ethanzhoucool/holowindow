/** Messages exchanged between the main thread and depthWorker.ts. */

export const DEPTH_MODEL_ID = 'onnx-community/depth-anything-v2-small';

export interface EstimateRequest {
  type: 'estimate';
  id: number;
  width: number;
  height: number;
  /** RGBA8 pixels, row-major, top row first. Transferred. */
  pixels: ArrayBuffer;
}

export type WorkerRequest = EstimateRequest;

export type WorkerResponse =
  | { type: 'status'; id: number; message: string }
  | { type: 'progress'; id: number; progress: number; loaded: number; total: number }
  | {
      type: 'result';
      id: number;
      width: number;
      height: number;
      /** Uint8 nearness map (255 = nearest), row-major, top row first. Transferred. */
      depth: ArrayBuffer;
      device: string;
    }
  | { type: 'error'; id: number; message: string };

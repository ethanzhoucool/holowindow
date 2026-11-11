import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Draco decoder (wasm + JS wrapper), served from jsDelivr and pinned to the exact three.js
 * release we are bundled with so the decoder always matches DRACOLoader's expectations.
 * Only fetched the first time a Draco-compressed file is actually decoded.
 */
export const DRACO_DECODER_PATH = `https://cdn.jsdelivr.net/npm/three@0.${THREE.REVISION}.0/examples/jsm/libs/draco/gltf/`;

const MAGIC_GLB = 0x46546c67; // 'glTF' little-endian

export interface GltfLoaderHandle {
  load(src: File | string, onStatus?: (msg: string) => void): Promise<GLTF>;
  dispose(): void;
}

export function createGltfLoader(): GltfLoaderHandle {
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_PATH);

  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);

  async function loadFile(file: File, status: (msg: string) => void): Promise<GLTF> {
    const name = file.name || 'model';
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (file.size === 0) throw new Error(`"${name}" is empty.`);
    status(`Reading ${name} (${formatBytes(file.size)})…`);
    const buffer = await file.arrayBuffer();

    const isGlb = buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === MAGIC_GLB;
    if (isGlb) {
      checkGlbHeader(buffer, name);
      status(`Parsing ${name}…`);
      return parse(buffer, name, null);
    }

    if (ext === 'glb') throw new Error(`"${name}" is not a valid .glb file (missing glTF header).`);

    let json: GltfJson;
    let text: string;
    try {
      text = new TextDecoder().decode(buffer);
      json = JSON.parse(text) as GltfJson;
    } catch {
      throw new Error(
        ext === 'gltf'
          ? `"${name}" is not valid glTF JSON.`
          : `"${name}" doesn't look like a glTF model. Please drop a .glb or .gltf file.`,
      );
    }
    if (!json || typeof json !== 'object' || !json.asset) {
      throw new Error(`"${name}" is not a glTF 2.0 file (no "asset" block).`);
    }

    const external = externalUris(json);
    if (external.length) {
      const shown = external.slice(0, 3).join(', ') + (external.length > 3 ? `, +${external.length - 3} more` : '');
      throw new Error(
        `"${name}" references external files (${shown}) that the browser can't read from a single drop. ` +
          'Export it as a binary .glb (or a .gltf with embedded resources) and try again.',
      );
    }

    status(`Parsing ${name}…`);
    return parse(text, name, json);
  }

  async function parse(data: ArrayBuffer | string, name: string, json: GltfJson | null): Promise<GLTF> {
    try {
      return await loader.parseAsync(data, '');
    } catch (err) {
      throw explain(err, name, json ?? glbJson(data));
    }
  }

  async function loadUrl(url: string, status: (msg: string) => void): Promise<GLTF> {
    const name = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || 'model');
    status(`Downloading ${name}…`);
    try {
      return await loader.loadAsync(url, (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0 && e.loaded <= e.total) {
          status(`Downloading ${name}… ${Math.round((e.loaded / e.total) * 100)}%`);
        } else if (e.loaded) {
          status(`Downloading ${name}… ${formatBytes(e.loaded)}`);
        }
      });
    } catch (err) {
      throw explain(err, name, null);
    }
  }

  return {
    async load(src, onStatus) {
      const status = onStatus ?? (() => {});
      const gltf = typeof src === 'string' ? await loadUrl(src, status) : await loadFile(src, status);
      status('Staging model…');
      return gltf;
    },
    dispose() {
      draco.dispose();
    },
  };
}

// ---------- helpers ----------

interface GltfJson {
  asset?: unknown;
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

function externalUris(json: GltfJson): string[] {
  const out: string[] = [];
  for (const list of [json.buffers, json.images]) {
    for (const item of list ?? []) {
      if (item?.uri && !item.uri.startsWith('data:')) out.push(item.uri);
    }
  }
  return out;
}

function checkGlbHeader(buffer: ArrayBuffer, name: string): void {
  if (buffer.byteLength < 20) throw new Error(`"${name}" is truncated.`);
  const view = new DataView(buffer);
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`"${name}" is glTF ${version}.0; only glTF 2.0 is supported.`);
  const length = view.getUint32(8, true);
  if (length > buffer.byteLength) throw new Error(`"${name}" is truncated (download incomplete?).`);
}

/** Pull the JSON chunk out of a .glb so error messages can mention the extensions it uses. */
function glbJson(data: ArrayBuffer | string): GltfJson | null {
  if (typeof data === 'string') return null;
  try {
    const view = new DataView(data);
    const len = view.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, len))) as GltfJson;
  } catch {
    return null;
  }
}

function explain(err: unknown, name: string, json: GltfJson | null): Error {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String((err as Event)?.type ?? err);
  const used = new Set([...(json?.extensionsUsed ?? []), ...(json?.extensionsRequired ?? [])]);
  const required = new Set(json?.extensionsRequired ?? []);

  if (used.has('KHR_draco_mesh_compression') && /draco|wasm|fetch|network|decoder/i.test(raw)) {
    return new Error(
      `"${name}" uses Draco compression and the decoder couldn't be downloaded (${raw}). Check your internet connection.`,
    );
  }
  if (/KHR_texture_basisu|KTX2/i.test(raw) || required.has('KHR_texture_basisu')) {
    return new Error(`"${name}" uses KTX2/Basis textures, which aren't supported here. Re-export with PNG/JPEG/WebP textures.`);
  }
  if (/Unknown extension/i.test(raw)) {
    return new Error(`"${name}" requires an unsupported glTF extension (${raw}).`);
  }
  if (/version/i.test(raw) && /1\.0|unsupported asset/i.test(raw)) {
    return new Error(`"${name}" is a glTF 1.0 file; only glTF 2.0 is supported.`);
  }
  if (/404|Failed to fetch|NetworkError|status/i.test(raw)) {
    return new Error(`Couldn't download "${name}" (${raw}).`);
  }
  return new Error(`Couldn't read "${name}": ${raw}`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

import * as THREE from 'three';
import './style.css';
import { OffAxisCamera } from './render/offAxisCamera';
import { FaceTracker } from './tracking/faceTracker';
import { MouseSource } from './tracking/mouseSource';
import type { PhotoScene } from './scenes/photoScene';
import type { ModelScene } from './scenes/modelScene';
import { createHud, hasSeenIntro } from './ui/hud';
import {
  DEFAULT_POSE,
  DEFAULT_SETTINGS,
  MODES,
  MODE_LABELS,
  type HeadPose,
  type Mode,
  type HeadSource,
  type HoloScene,
  type SceneContext,
  type Settings,
  type ViewportSpec,
} from './types';

const STORAGE_KEY = 'holowindow:settings:v1';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      if (!MODES.includes(s.mode)) s.mode = DEFAULT_SETTINGS.mode;
      return s;
    }
  } catch {
    /* storage unavailable */
  }
  return structuredClone(DEFAULT_SETTINGS);
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

let settings = loadSettings();

// ---------- renderer ----------
const canvas = document.createElement('canvas');
canvas.id = 'stage';
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
const camera = new OffAxisCamera();

// ---------- physical viewport ----------
/** cm per CSS pixel, derived from the monitor's physical width and its CSS-pixel width. */
function cmPerPx(): number {
  return settings.screen.widthCm / window.screen.width;
}

function computeViewport(): ViewportSpec {
  const k = cmPerPx();
  return { widthCm: window.innerWidth * k, heightCm: window.innerHeight * k };
}

/**
 * The face tracker reports poses relative to the centre of the whole MONITOR.
 * The window may not be centred on the monitor, so shift into viewport-centred coords.
 * (screenX/Y aren't perfect — browser chrome — but it's close, and exact in fullscreen.)
 */
function monitorToViewport(p: HeadPose): HeadPose {
  if (document.fullscreenElement) return p;
  const k = cmPerPx();
  const chromeTop = window.outerHeight - window.innerHeight;
  const vpCx = window.screenX + window.innerWidth / 2 - window.screen.width / 2;
  const vpCy = window.screenY + chromeTop + window.innerHeight / 2 - window.screen.height / 2;
  return { ...p, x: p.x - vpCx * k, y: p.y + vpCy * k };
}

let ctx: SceneContext = { renderer, viewport: computeViewport(), settings };

function onResize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  ctx = { renderer, viewport: computeViewport(), settings };
  active?.resize(ctx);
}
window.addEventListener('resize', onResize);

// ---------- scenes ----------
// Each scene is its own chunk, loaded the first time its mode is picked.
const sceneFactories: Record<Mode, () => Promise<HoloScene>> = {
  room: () => import('./scenes/roomScene').then((m) => m.createRoomScene()),
  space: () => import('./scenes/spaceScene').then((m) => m.createSpaceScene()),
  aquarium: () => import('./scenes/aquariumScene').then((m) => m.createAquariumScene()),
  photo: () => import('./scenes/photoScene').then((m) => m.createPhotoScene()),
  model: () => import('./scenes/modelScene').then((m) => m.createModelScene()),
};
const scenes = new Map<Mode, Promise<HoloScene>>();
let active: HoloScene | null = null;
let modeRequest = 0;

function getScene(mode: Mode): Promise<HoloScene> {
  let p = scenes.get(mode);
  if (!p) {
    p = sceneFactories[mode]().then(async (sc) => {
      await sc.init(ctx);
      return sc;
    });
    p.catch(() => scenes.delete(mode));
    scenes.set(mode, p);
  }
  return p;
}

async function setMode(mode: Mode): Promise<HoloScene> {
  const req = ++modeRequest;
  const firstLoad = !scenes.has(mode);
  if (firstLoad && active) hud.setStatus(`Loading ${MODE_LABELS[mode]}…`);
  const next = await getScene(mode);
  if (req !== modeRequest) return next; // a newer mode switch won
  if (next !== active) {
    if (active) scene.remove(active.root);
    active = next;
    scene.add(next.root);
  }
  next.resize(ctx);
  return next;
}

async function switchToMode(mode: Mode): Promise<HoloScene> {
  if (settings.mode !== mode) {
    settings = { ...settings, mode };
    hud.setSettings(settings);
    saveSettings(settings);
  }
  return setMode(mode);
}

// ---------- head sources ----------
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.autoplay = true;

const face = new FaceTracker(settings, video);
const mouse = new MouseSource(canvas);
let source: HeadSource = mouse;
let faceStarted = false;
let facePromise: Promise<void> | null = null;

function startFace(): Promise<void> {
  if (faceStarted) return Promise.resolve();
  if (facePromise) return facePromise;
  hud.setStatus('Starting camera and loading face model…');
  facePromise = face
    .start()
    .then(() => {
      faceStarted = true;
      hud.setVideo(video);
      hud.setStatus('Tracking your face. Move your head!', 'ok');
    })
    .catch((err: unknown) => {
      console.error(err);
      hud.setStatus(`Camera unavailable (${(err as Error).message}). Using mouse instead.`, 'error');
      settings = { ...settings, source: 'mouse' };
      hud.setSettings(settings);
      saveSettings(settings);
    })
    .finally(() => {
      facePromise = null;
    });
  return facePromise;
}

async function applySource(): Promise<void> {
  await mouse.start();
  if (settings.source === 'face') {
    await startFace();
    source = faceStarted && settings.source === 'face' ? face : mouse;
  } else {
    source = mouse;
    if (faceStarted) {
      face.stop(); // turn the camera light off
      faceStarted = false;
    }
  }
}

// ---------- HUD ----------
const hud = createHud(document.body, settings, {
  onSettingsChange(next) {
    const prev = settings;
    settings = next;
    saveSettings(settings);
    face.updateSettings(settings);
    onResize();
    if (prev.mode !== next.mode) void setMode(next.mode);
    if (prev.source !== next.source) void applySource();
  },
  async onImage(file) {
    try {
      const photo = (await switchToMode('photo')) as PhotoScene;
      await photo.loadImage(file, (msg) => hud.setStatus(msg));
      hud.setStatus('Depth ready. Look around.', 'ok');
    } catch (err) {
      console.error(err);
      hud.setStatus(`Could not process image: ${(err as Error).message}`, 'error');
    }
  },
  async onModel(file) {
    try {
      const model = (await switchToMode('model')) as ModelScene;
      await model.loadModel(file, (msg) => hud.setStatus(msg));
      hud.setStatus('Model loaded. Walk around it.', 'ok');
    } catch (err) {
      console.error(err);
      hud.setStatus(`Could not load model: ${(err as Error).message}`, 'error');
    }
  },
  onRecenter() {
    face.recenter();
  },
  onToggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  },
  onStartCamera() {
    settings = { ...settings, source: 'face' };
    hud.setSettings(settings);
    saveSettings(settings);
    void applySource();
  },
});

// ---------- loop ----------
let last = performance.now();
let fps = 60;
let pose: HeadPose = { ...DEFAULT_POSE };

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;

  let raw = source.getPose();
  if (source === face) raw = monitorToViewport(raw);
  const g = settings.motionGain;
  pose = { ...raw, x: raw.x * g, y: raw.y * g, z: DEFAULT_POSE.z + (raw.z - DEFAULT_POSE.z) * g };

  camera.updateFromHead(pose, ctx.viewport);
  active?.update(dt, pose, ctx);
  renderer.render(scene, camera);
  hud.update(pose, fps);
  requestAnimationFrame(frame);
}

onResize();
await setMode(settings.mode);
requestAnimationFrame(frame);
// Mouse works immediately. On first run, wait for the intro's "Enable camera" button
// so the permission prompt doesn't appear behind the overlay.
if (hasSeenIntro() || settings.source === 'mouse') void applySource();
else void mouse.start();

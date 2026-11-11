import * as THREE from 'three';
import './style.css';
import { OffAxisCamera } from './render/offAxisCamera';
import { FaceTracker } from './tracking/faceTracker';
import { MouseSource } from './tracking/mouseSource';
import { createRoomScene } from './scenes/roomScene';
import { createPhotoScene, type PhotoScene } from './scenes/photoScene';
import { createHud } from './ui/hud';
import {
  DEFAULT_POSE,
  DEFAULT_SETTINGS,
  type HeadPose,
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
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
const room = createRoomScene();
const photo: PhotoScene = createPhotoScene();
let active: HoloScene | null = null;
const initialised = new Set<HoloScene>();

async function setMode(mode: Settings['mode']): Promise<void> {
  const next = mode === 'photo' ? photo : room;
  if (next === active) return;
  if (active) scene.remove(active.root);
  if (!initialised.has(next)) {
    await next.init(ctx);
    initialised.add(next);
  }
  active = next;
  scene.add(next.root);
  next.resize(ctx);
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

async function startFace(): Promise<void> {
  if (faceStarted) return;
  hud.setStatus('Starting camera and loading face model…');
  try {
    await face.start();
    faceStarted = true;
    hud.setVideo(video);
    hud.setStatus('Tracking your face. Move your head!', 'ok');
  } catch (err) {
    console.error(err);
    hud.setStatus(`Camera unavailable (${(err as Error).message}). Using mouse instead.`, 'error');
    settings = { ...settings, source: 'mouse' };
    hud.setSettings(settings);
    saveSettings(settings);
  }
}

async function applySource(): Promise<void> {
  if (settings.source === 'face') {
    await mouse.start();
    await startFace();
    source = faceStarted ? face : mouse;
  } else {
    await mouse.start();
    source = mouse;
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
    if (settings.mode !== 'photo') {
      settings = { ...settings, mode: 'photo' };
      hud.setSettings(settings);
      saveSettings(settings);
      await setMode('photo');
    }
    try {
      await photo.loadImage(file, (msg) => hud.setStatus(msg));
      hud.setStatus('Depth ready — look around!', 'ok');
    } catch (err) {
      console.error(err);
      hud.setStatus(`Could not process image: ${(err as Error).message}`, 'error');
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
// Mouse works immediately; the face tracker needs a user gesture-free permission prompt,
// which browsers allow on page load, but we still let the HUD call-to-action trigger it
// if the user previously chose mouse.
void applySource();

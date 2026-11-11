import { DEFAULT_SETTINGS, MODES, MODE_LABELS, type HeadPose, type Mode, type Settings, type SourceKind } from '../types';
import { createCalibrationWizard, diagonalIn } from './calibration';
import type { Hud, HudCallbacks } from './contracts';
import { h, icon, nextId, setIcon, trapTab, type IconName } from './dom';
import { SCREEN_PRESETS, matchPreset } from './presets';

const INTRO_KEY = 'holowindow:intro-dismissed:v1';
const CALIBRATED_KEY = 'holowindow:calibrated:v1';
const CALIB_NUDGE_KEY = 'holowindow:calibration-nudge:v1';
const NUDGE_DELAY_MS = 2500;
const NUDGE_MS = 15000;
const RESET_CONFIRM_MS = 3000;

const MODE_ICONS: Record<Mode, IconName> = {
  room: 'room',
  space: 'space',
  aquarium: 'aquarium',
  photo: 'photo',
  model: 'model',
};

const MODEL_EXT = /\.(glb|gltf)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

function fileKind(file: File): 'model' | 'image' | null {
  if (MODEL_EXT.test(file.name) || file.type.startsWith('model/gltf')) return 'model';
  if (file.type.startsWith('image/') || (!file.type && IMAGE_EXT.test(file.name))) return 'image';
  return null;
}
const IDLE_MS = 3000;
const DEBUG_INTERVAL_MS = 100;

/** True once the user has dismissed the first-run intro (persisted in localStorage). */
export function hasSeenIntro(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function setFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* storage unavailable */
  }
}

function rememberIntro(): void {
  setFlag(INTRO_KEY);
}

function cloneSettings(s: Settings): Settings {
  return { ...s, screen: { ...s.screen } };
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName);
}

interface Control {
  sync(s: Settings): void;
}

export function createHud(parent: HTMLElement, initial: Settings, cb: HudCallbacks): Hud {
  let settings = cloneSettings(initial);
  const controls: Control[] = [];
  let imageLoaded = false;
  let modelLoaded = false;
  let cameraLive = false;

  const commit = (patch: Partial<Settings>): void => {
    settings = { ...settings, ...patch, screen: { ...(patch.screen ?? settings.screen) } };
    syncAll();
    cb.onSettingsChange(cloneSettings(settings));
  };

  const root = h('div', { class: 'hw-hud' });
  parent.appendChild(root);

  // ---------------------------------------------------------------- segmented toggles
  function segmented<T extends string>(
    label: string,
    options: { value: T; text: string; icon: IconName }[],
    get: (s: Settings) => T,
    set: (v: T) => void,
  ): HTMLElement {
    const buttons = options.map((o) =>
      h(
        'button',
        {
          type: 'button',
          class: 'hw-seg-btn',
          title: o.text,
          onclick: () => {
            if (get(settings) !== o.value) set(o.value);
          },
        },
        icon(o.icon),
        h('span', { class: 'hw-label' }, o.text),
      ),
    );
    const group = h('div', { class: 'hw-seg', role: 'group', 'aria-label': label }, ...buttons);
    controls.push({
      sync(s) {
        buttons.forEach((b, i) => {
          const on = get(s) === options[i].value;
          b.setAttribute('aria-pressed', String(on));
          b.classList.toggle('is-on', on);
        });
      },
    });
    return group;
  }

  function iconButton(name: IconName, label: string, onclick: () => void, shortcut?: string): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        class: 'hw-btn',
        'aria-label': label,
        title: shortcut ? `${label} (${shortcut})` : label,
        'aria-keyshortcuts': shortcut,
        onclick,
      },
      icon(name),
    );
  }

  // ---------------------------------------------------------------- file input / upload
  const fileInput = h('input', {
    type: 'file',
    accept: 'image/*,.glb,.gltf,model/gltf-binary,model/gltf+json',
    class: 'hw-visually-hidden',
    tabindex: -1,
    'aria-hidden': 'true',
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });

  /** main.ts switches mode itself in onImage / onModel; mirror it locally so the picker is right. */
  function mirrorMode(mode: Mode): void {
    if (settings.mode === mode) return;
    settings = { ...settings, mode };
    syncAll();
  }

  function rejectFile(name: string): void {
    setStatus(`"${name}" isn't supported. Use an image (JPG, PNG, WebP) or a .glb / .gltf model.`, 'error');
  }

  function handleFile(file: File): void {
    const kind = fileKind(file);
    if (kind === 'model') {
      modelLoaded = true;
      mirrorMode('model');
      cb.onModel(file);
    } else if (kind === 'image') {
      imageLoaded = true;
      mirrorMode('photo');
      cb.onImage(file);
    } else rejectFile(file.name);
  }

  // ---------------------------------------------------------------- dock
  const modeButtons = MODES.map((m, i) =>
    h(
      'button',
      {
        type: 'button',
        class: 'hw-seg-btn hw-mode-btn',
        title: `${MODE_LABELS[m]} (${i + 1})`,
        'aria-keyshortcuts': String(i + 1),
        onclick: () => {
          if (settings.mode !== m) setMode(m);
        },
      },
      icon(MODE_ICONS[m]),
      h('span', { class: 'hw-mode-label' }, MODE_LABELS[m]),
    ),
  );
  const modeSeg = h('div', { class: 'hw-seg hw-mode-seg', role: 'group', 'aria-label': 'Scene' }, ...modeButtons);

  // Under ~600px the segmented picker collapses into a native dropdown.
  const modeSelectIcon = icon('room');
  const modeSelect = h(
    'select',
    { class: 'hw-mode-select', 'aria-label': 'Scene' },
    ...MODES.map((m) => h('option', { value: m }, MODE_LABELS[m])),
  );
  modeSelect.addEventListener('change', () => setMode(modeSelect.value as Mode));
  const modeDrop = h('div', { class: 'hw-mode-drop' }, modeSelectIcon, modeSelect, h('span', { class: 'hw-mode-chev' }, icon('chevronDown')));
  controls.push({
    sync(s) {
      modeButtons.forEach((b, i) => {
        const on = s.mode === MODES[i];
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('is-on', on);
      });
      modeSelect.value = s.mode;
      setIcon(modeSelectIcon, MODE_ICONS[s.mode]);
    },
  });
  const sourceSeg = segmented<SourceKind>(
    'Head tracking source',
    [
      { value: 'face', text: 'Face', icon: 'face' },
      { value: 'mouse', text: 'Mouse', icon: 'mouse' },
    ],
    (s) => s.source,
    (v) => {
      if (v === 'face') {
        settings = { ...settings, source: 'face' };
        syncAll();
        cb.onStartCamera();
      } else commit({ source: v });
    },
  );

  const uploadBtn = h(
    'button',
    {
      type: 'button',
      class: 'hw-btn hw-btn-accent',
      'aria-label': 'Upload an image or 3D model',
      title: 'Upload an image or .glb model (or drop one anywhere)',
      onclick: () => fileInput.click(),
    },
    icon('upload'),
    h('span', { class: 'hw-label' }, 'Upload'),
  );
  const recenterBtn = iconButton('recenter', 'Recenter', () => recenter(), 'R');
  const fsBtn = iconButton('fullscreen', 'Enter fullscreen', () => cb.onToggleFullscreen(), 'F');
  const settingsBtn = iconButton('settings', 'Settings', () => toggleSettings());

  const dock = h(
    'div',
    { class: 'hw-dock hw-glass', role: 'toolbar', 'aria-label': 'HoloWindow controls' },
    modeSeg,
    modeDrop,
    h('span', { class: 'hw-sep', 'aria-hidden': 'true' }),
    sourceSeg,
    h('span', { class: 'hw-sep', 'aria-hidden': 'true' }),
    uploadBtn,
    recenterBtn,
    fsBtn,
    settingsBtn,
    fileInput,
  );

  // ---------------------------------------------------------------- settings panel
  function slider(opts: {
    label: string;
    min: number;
    max: number;
    step: number;
    get: (s: Settings) => number;
    set: (v: number) => void;
    format: (v: number) => string;
    hint?: string;
  }): HTMLElement {
    const id = nextId('hw-range');
    const out = h('output', { class: 'hw-out', for: id });
    const input = h('input', {
      id,
      type: 'range',
      min: opts.min,
      max: opts.max,
      step: opts.step,
      class: 'hw-range',
    });
    const paint = (v: number): void => {
      out.textContent = opts.format(v);
      input.setAttribute('aria-valuetext', opts.format(v));
      const pct = ((v - opts.min) / (opts.max - opts.min)) * 100;
      input.style.setProperty('--fill', `${pct}%`);
    };
    input.addEventListener('input', () => {
      const v = Number(input.value);
      paint(v);
      opts.set(v);
    });
    controls.push({
      sync(s) {
        const v = opts.get(s);
        if (document.activeElement !== input || Number(input.value) !== v) input.value = String(v);
        paint(v);
      },
    });
    return h(
      'div',
      { class: 'hw-field' },
      h('div', { class: 'hw-field-head' }, h('label', { for: id }, opts.label), out),
      input,
      opts.hint ? h('p', { class: 'hw-hint' }, opts.hint) : null,
    );
  }

  function numberInput(label: string, get: (s: Settings) => number, set: (v: number) => void): HTMLElement {
    const id = nextId('hw-num');
    const input = h('input', {
      id,
      type: 'number',
      min: 5,
      max: 400,
      step: 0.1,
      inputmode: 'decimal',
      class: 'hw-num',
    });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v >= 5 && v <= 400) set(Math.round(v * 10) / 10);
      else input.value = String(get(settings));
    });
    controls.push({
      sync(s) {
        if (document.activeElement !== input) input.value = String(get(s));
      },
    });
    return h('div', { class: 'hw-num-wrap' }, h('label', { for: id }, label), input, h('span', { class: 'hw-unit', 'aria-hidden': 'true' }, 'cm'));
  }

  const presetId = nextId('hw-preset');
  const presetSelect = h(
    'select',
    { id: presetId, class: 'hw-select' },
    h('option', { value: 'custom' }, 'Custom size'),
    ...SCREEN_PRESETS.map((p) => h('option', { value: p.id }, `${p.label} · ${p.size.widthCm}×${p.size.heightCm} cm`)),
  );
  presetSelect.addEventListener('change', () => {
    const p = SCREEN_PRESETS.find((x) => x.id === presetSelect.value);
    if (p) commit({ screen: { ...p.size } });
  });
  controls.push({
    sync(s) {
      presetSelect.value = matchPreset(s.screen) ?? 'custom';
    },
  });

  const debugId = nextId('hw-debug');
  const debugToggle = h('input', { id: debugId, type: 'checkbox', role: 'switch', class: 'hw-switch' });
  debugToggle.addEventListener('change', () => commit({ showDebug: debugToggle.checked }));
  controls.push({
    sync(s) {
      debugToggle.checked = s.showDebug;
    },
  });

  const calibrateBtn = h(
    'button',
    { type: 'button', class: 'hw-btn hw-btn-outline hw-btn-block', onclick: () => openCalibration(calibrateBtn) },
    icon('card'),
    'Calibrate with a card…',
  );
  const screenSummary = h('p', { class: 'hw-hint' });
  controls.push({
    sync(s) {
      screenSummary.textContent = `${diagonalIn(s.screen).toFixed(1)}″ diagonal. Accurate size is what makes the illusion line up.`;
    },
  });

  const depthField = slider({
    label: 'Photo depth',
    min: 2,
    max: 40,
    step: 0.5,
    get: (s) => s.depthScale,
    set: (v) => commit({ depthScale: v }),
    format: (v) => `${v.toFixed(1)} cm`,
    hint: 'How far the photo relief extends into the screen.',
  });
  const depthNote = h('p', { class: 'hw-hint' }, 'Switch to Photo mode for relief depth.');
  controls.push({
    sync(s) {
      depthField.hidden = s.mode !== 'photo';
      depthNote.hidden = s.mode === 'photo';
    },
  });

  let resetArmed = 0;
  const resetLabel = h('span', {}, 'Reset to defaults');
  const resetBtn = h(
    'button',
    {
      type: 'button',
      class: 'hw-btn hw-btn-ghost',
      onclick: () => {
        if (!resetArmed) {
          resetLabel.textContent = 'Click again to reset';
          resetBtn.classList.add('is-armed');
          resetArmed = window.setTimeout(disarmReset, RESET_CONFIRM_MS);
          return;
        }
        disarmReset();
        // Keep the current scene and tracking source: resetting shouldn't pop a camera prompt.
        commit({ ...DEFAULT_SETTINGS, screen: { ...DEFAULT_SETTINGS.screen }, mode: settings.mode, source: settings.source });
        setStatus('Settings reset to defaults.', 'ok');
      },
    },
    icon('reset'),
    resetLabel,
  );
  function disarmReset(): void {
    window.clearTimeout(resetArmed);
    resetArmed = 0;
    resetLabel.textContent = 'Reset to defaults';
    resetBtn.classList.remove('is-armed');
  }

  const panelId = nextId('hw-settings');
  const panelTitleId = nextId('hw-settings-title');
  const closeSettingsBtn = iconButton('close', 'Close settings', () => toggleSettings(false));
  const panel = h(
    'section',
    { id: panelId, class: 'hw-panel hw-glass', 'aria-labelledby': panelTitleId, hidden: true },
    h('header', { class: 'hw-panel-head' }, h('h2', { id: panelTitleId }, 'Settings'), closeSettingsBtn),
    h(
      'div',
      { class: 'hw-panel-body' },
      h(
        'fieldset',
        { class: 'hw-group' },
        h('legend', {}, 'Display'),
        h('div', { class: 'hw-field' }, h('label', { for: presetId }, 'Screen size'), presetSelect),
        h(
          'div',
          { class: 'hw-row' },
          numberInput('Width', (s) => s.screen.widthCm, (v) => commit({ screen: { ...settings.screen, widthCm: v } })),
          numberInput('Height', (s) => s.screen.heightCm, (v) => commit({ screen: { ...settings.screen, heightCm: v } })),
        ),
        screenSummary,
        calibrateBtn,
        h(
          'div',
          { class: 'hw-switch-row' },
          h('label', { for: debugId }, 'Debug overlay', h('span', { class: 'hw-hint' }, 'Webcam preview, head position, FPS')),
          debugToggle,
        ),
      ),
      h(
        'fieldset',
        { class: 'hw-group' },
        h('legend', {}, 'Tracking'),
        slider({
          label: 'Smoothing',
          min: 0,
          max: 1,
          step: 0.01,
          get: (s) => s.smoothing,
          set: (v) => commit({ smoothing: v }),
          format: (v) => `${Math.round(v * 100)}%`,
        }),
        slider({
          label: 'Webcam field of view',
          min: 40,
          max: 90,
          step: 1,
          get: (s) => s.cameraFovDeg,
          set: (v) => commit({ cameraFovDeg: v }),
          format: (v) => `${Math.round(v)}°`,
        }),
        slider({
          label: 'Webcam above screen edge',
          min: 0,
          max: 3,
          step: 0.1,
          get: (s) => s.cameraOffsetYcm,
          set: (v) => commit({ cameraOffsetYcm: v }),
          format: (v) => `${v.toFixed(1)} cm`,
        }),
      ),
      h(
        'fieldset',
        { class: 'hw-group' },
        h('legend', {}, 'Effect'),
        slider({
          label: 'Motion gain',
          min: 0.5,
          max: 3,
          step: 0.05,
          get: (s) => s.motionGain,
          set: (v) => commit({ motionGain: v }),
          format: (v) => `${v.toFixed(2)}×`,
          hint: '1× is physically correct. Higher exaggerates the parallax.',
        }),
        depthField,
        depthNote,
      ),
      h(
        'dl',
        { class: 'hw-keys', 'aria-label': 'Keyboard shortcuts' },
        ...(
          [
            ['Space', 'Next scene'],
            ['1–5', 'Jump to scene'],
            ['H', 'Hide / show controls'],
            ['F', 'Fullscreen'],
            ['R', 'Recenter'],
            ['Esc', 'Close panel / dialog'],
          ] as const
        ).flatMap(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)]),
      ),
      h('div', { class: 'hw-panel-foot' }, resetBtn),
    ),
  );
  settingsBtn.setAttribute('aria-controls', panelId);
  settingsBtn.setAttribute('aria-expanded', 'false');

  let settingsOpen = false;
  function toggleSettings(force?: boolean): void {
    settingsOpen = force ?? !settingsOpen;
    panel.hidden = !settingsOpen;
    settingsBtn.setAttribute('aria-expanded', String(settingsOpen));
    settingsBtn.classList.toggle('is-on', settingsOpen);
    if (!settingsOpen) disarmReset();
    if (settingsOpen) wake();
    else if (panel.contains(document.activeElement)) settingsBtn.focus();
  }

  const chrome = h('div', { class: 'hw-chrome' }, panel, dock);
  root.appendChild(chrome);

  // ---------------------------------------------------------------- status toast
  const statusText = h('span', { class: 'hw-status-text' });
  const statusClose = h('button', { type: 'button', class: 'hw-status-close', 'aria-label': 'Dismiss message' }, icon('close'));
  const status = h('div', { class: 'hw-status hw-glass', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'hw-status-dot', 'aria-hidden': 'true' }), statusText, statusClose);
  root.appendChild(status);
  let statusTimer = 0;
  statusClose.addEventListener('click', () => status.classList.remove('is-visible'));

  function setStatus(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
    window.clearTimeout(statusTimer);
    statusText.textContent = text;
    status.dataset.kind = kind;
    status.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    status.classList.add('is-visible');
    if (kind !== 'error') {
      statusTimer = window.setTimeout(() => status.classList.remove('is-visible'), kind === 'ok' ? 3500 : 6000);
    }
  }

  // ---------------------------------------------------------------- debug view
  const videoSlot = h('div', { class: 'hw-debug-video' }, h('span', { class: 'hw-debug-novideo' }, 'No camera'));
  const dbg = {
    x: h('span', {}),
    y: h('span', {}),
    z: h('span', {}),
    conf: h('span', {}),
    fps: h('span', {}),
    tracked: h('span', { class: 'hw-tracked' }),
  };
  const debugPanel = h(
    'aside',
    { class: 'hw-debug hw-glass', 'aria-label': 'Debug information', hidden: true },
    videoSlot,
    h(
      'dl',
      { class: 'hw-debug-grid' },
      h('dt', {}, 'x'), h('dd', {}, dbg.x),
      h('dt', {}, 'y'), h('dd', {}, dbg.y),
      h('dt', {}, 'z'), h('dd', {}, dbg.z),
      h('dt', {}, 'conf'), h('dd', {}, dbg.conf),
      h('dt', {}, 'fps'), h('dd', {}, dbg.fps),
    ),
    dbg.tracked,
  );
  chrome.appendChild(debugPanel);
  controls.push({
    sync(s) {
      debugPanel.hidden = !s.showDebug;
    },
  });

  let lastDebugWrite = 0;
  function update(pose: HeadPose, fps: number): void {
    wizard.updatePose(pose);
    if (!settings.showDebug) return;
    const now = performance.now();
    if (now - lastDebugWrite < DEBUG_INTERVAL_MS) return;
    lastDebugWrite = now;
    dbg.x.textContent = `${pose.x.toFixed(1)} cm`;
    dbg.y.textContent = `${pose.y.toFixed(1)} cm`;
    dbg.z.textContent = `${pose.z.toFixed(1)} cm`;
    dbg.conf.textContent = pose.confidence.toFixed(2);
    dbg.fps.textContent = Math.round(fps).toString();
    dbg.tracked.textContent = pose.tracked ? 'Tracking' : 'No face';
    dbg.tracked.classList.toggle('is-on', pose.tracked);
  }

  function setVideo(video: HTMLVideoElement): void {
    video.classList.add('hw-video');
    video.setAttribute('aria-label', 'Webcam preview (mirrored)');
    videoSlot.replaceChildren(video);
    void video.play().catch(() => {
      /* autoplay may be blocked until interaction; the tracker owns playback anyway */
    });
    if (!cameraLive) {
      cameraLive = true;
      // Let main.ts's "tracking" toast land first, then offer calibration once.
      window.setTimeout(maybeNudgeCalibration, NUDGE_DELAY_MS);
    }
  }

  // ---------------------------------------------------------------- calibration wizard
  const wizard = createCalibrationWizard({
    getSettings: () => cloneSettings(settings),
    onSave(screen) {
      setFlag(CALIBRATED_KEY);
      commit({ screen });
      setStatus(`Screen set to ${screen.widthCm.toFixed(1)} × ${screen.heightCm.toFixed(1)} cm (${diagonalIn(screen).toFixed(1)}″).`, 'ok');
    },
    onFov: (deg) => commit({ cameraFovDeg: deg }),
    onStartCamera: () => startCamera(),
    isCameraLive: () => cameraLive,
    onClose() {
      wake();
    },
  });
  root.appendChild(wizard.el);

  function openCalibration(returnFocus: HTMLElement | null = null): void {
    hideNudge();
    setFlag(CALIB_NUDGE_KEY);
    wizard.open(returnFocus);
  }

  function startCamera(): void {
    if (introOpen) closeIntro();
    settings = { ...settings, source: 'face' };
    syncAll();
    cb.onStartCamera();
  }

  // One-time nudge after the camera first starts. Separate from the status toast so
  // main.ts's own status messages don't overwrite it.
  const nudgeText = h('span', { class: 'hw-nudge-text' }, 'Calibrate your screen size for the best effect.');
  const nudgeGo = h('button', { type: 'button', class: 'hw-btn hw-btn-primary hw-btn-small', onclick: () => openCalibration() }, 'Calibrate');
  const nudgeClose = h('button', { type: 'button', class: 'hw-status-close', 'aria-label': 'Dismiss', onclick: () => hideNudge() }, icon('close'));
  const nudge = h('div', { class: 'hw-nudge hw-glass', role: 'region', 'aria-label': 'Calibration suggestion' }, icon('card'), nudgeText, nudgeGo, nudgeClose);
  root.appendChild(nudge);
  let nudgeTimer = 0;
  function hideNudge(): void {
    window.clearTimeout(nudgeTimer);
    nudge.classList.remove('is-visible');
  }
  function maybeNudgeCalibration(): void {
    if (readFlag(CALIB_NUDGE_KEY) || readFlag(CALIBRATED_KEY) || wizard.isOpen() || introOpen) return;
    setFlag(CALIB_NUDGE_KEY);
    nudge.classList.add('is-visible');
    const schedule = (): void => {
      window.clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(() => {
        if (nudge.contains(document.activeElement) || nudge.matches(':hover')) schedule();
        else hideNudge();
      }, NUDGE_MS);
    };
    schedule();
  }

  // ---------------------------------------------------------------- intro overlay
  let introOpen = false;
  let introEl: HTMLElement | null = null;
  function closeIntro(): void {
    rememberIntro();
    introOpen = false;
    introEl?.classList.add('is-leaving');
    const el = introEl;
    window.setTimeout(() => el?.remove(), 350);
    introEl = null;
    wake();
  }
  if (!hasSeenIntro()) {
    const titleId = nextId('hw-intro-title');
    const enableBtn = h(
      'button',
      {
        type: 'button',
        class: 'hw-cta',
        onclick: () => startCamera(),
      },
      icon('camera'),
      'Enable camera',
    );
    const mouseBtn = h(
      'button',
      {
        type: 'button',
        class: 'hw-link',
        onclick: () => {
          closeIntro();
          if (settings.source !== 'mouse') commit({ source: 'mouse' });
        },
      },
      'Use mouse instead',
    );
    const calibLink = h(
      'button',
      { type: 'button', class: 'hw-link hw-link-small hw-intro-calib', onclick: () => openCalibration(calibLink) },
      icon('card'),
      'Calibrate screen for best effect',
    );
    introEl = h(
      'div',
      { class: 'hw-intro', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h(
        'div',
        { class: 'hw-intro-card hw-glass' },
        h('p', { class: 'hw-eyebrow' }, 'HoloWindow'),
        h('h1', { id: titleId }, 'Your screen is a window. ', h('span', { class: 'hw-glow' }, 'Look through it.')),
        h(
          'p',
          { class: 'hw-intro-lede' },
          'Your webcam tracks your head and re-projects the scene in real time, so the display behaves like a real window into a 3D space.',
        ),
        h('p', { class: 'hw-privacy' }, icon('lock'), 'Your camera feed never leaves your device. Everything runs locally in your browser.'),
        h('div', { class: 'hw-intro-actions' }, enableBtn, mouseBtn),
        calibLink,
        h('p', { class: 'hw-hint' }, 'Tip: close one eye. It looks even more real.'),
      ),
    );
    root.appendChild(introEl);
    introOpen = true;
    requestAnimationFrame(() => enableBtn.focus());
  }

  // ---------------------------------------------------------------- drag & drop
  const dropOverlay = h(
    'div',
    { class: 'hw-drop', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'hw-drop-inner' },
      icon('upload'),
      h('p', {}, 'Drop an image or .glb model'),
      h('span', { class: 'hw-hint' }, 'Images become 3D reliefs. Models float behind the glass.'),
    ),
  );
  root.appendChild(dropOverlay);
  let dragDepth = 0;
  const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    dropOverlay.classList.add('is-visible');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.remove('is-visible');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('is-visible');
    const files = Array.from(e.dataTransfer?.files ?? []);
    const usable = files.find((f) => fileKind(f) !== null);
    if (usable) handleFile(usable);
    else if (files.length) rejectFile(files[0].name);
  });

  // ---------------------------------------------------------------- auto-hide & keyboard
  let manuallyHidden = false;
  let idleTimer = 0;
  let pointerInChrome = false;

  function applyVisibility(idle: boolean): void {
    const hide = manuallyHidden || (idle && !settingsOpen && !pointerInChrome && !chrome.contains(document.activeElement));
    chrome.classList.toggle('is-hidden', hide);
    document.documentElement.classList.toggle('hw-idle', hide && !introOpen && !wizard.isOpen());
  }
  function wake(): void {
    applyVisibility(false);
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => applyVisibility(true), IDLE_MS);
  }
  chrome.addEventListener('pointerover', () => (pointerInChrome = true));
  chrome.addEventListener('pointerout', (e) => {
    if (!(e.relatedTarget instanceof Node) || !chrome.contains(e.relatedTarget)) pointerInChrome = false;
  });
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('pointerdown', wake, { passive: true });
  chrome.addEventListener('focusin', wake);

  function setMode(mode: Mode): void {
    commit({ mode });
    if (mode === 'photo' && !imageLoaded) setStatus('Drop an image anywhere, or press Upload', 'info');
    else if (mode === 'model' && !modelLoaded) setStatus('Drop a .glb file anywhere, or press Upload', 'info');
  }
  function recenter(): void {
    cb.onRecenter();
    setStatus('Recentered.', 'ok');
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (wizard.isOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        wizard.cancel();
      } else wizard.trap(e);
      return;
    }
    if (introOpen) {
      if (introEl) trapTab(introEl, e);
      return;
    }
    if (e.key === 'Escape' && settingsOpen) {
      toggleSettings(false);
      return;
    }
    if (e.key === 'Tab') wake();
    if (isTypingTarget(e.target)) return;
    switch (e.key.toLowerCase()) {
      case 'h':
        manuallyHidden = !manuallyHidden;
        if (manuallyHidden && chrome.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
        applyVisibility(manuallyHidden);
        if (!manuallyHidden) wake();
        break;
      case 'f':
        cb.onToggleFullscreen();
        break;
      case 'r':
        recenter();
        break;
      case ' ':
        if (e.repeat) return;
        e.preventDefault();
        setMode(MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]);
        break;
      default: {
        const n = Number(e.key);
        if (Number.isInteger(n) && n >= 1 && n <= MODES.length && !e.repeat) {
          if (MODES[n - 1] !== settings.mode) setMode(MODES[n - 1]);
        }
        return;
      }
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    const label = on ? 'Exit fullscreen' : 'Enter fullscreen';
    fsBtn.setAttribute('aria-label', label);
    fsBtn.title = `${label} (F)`;
    const span = fsBtn.querySelector<HTMLElement>('.hw-icon');
    if (span) setIcon(span, on ? 'exitFullscreen' : 'fullscreen');
  });

  // ---------------------------------------------------------------- init
  function syncAll(): void {
    for (const c of controls) c.sync(settings);
  }
  syncAll();
  wake();

  return {
    setStatus,
    update,
    setVideo,
    setSettings(next) {
      settings = cloneSettings(next);
      syncAll();
    },
  };
}

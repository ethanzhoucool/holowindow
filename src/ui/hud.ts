import type { HeadPose, Mode, Settings, SourceKind } from '../types';
import type { Hud, HudCallbacks } from './contracts';
import { h, icon, nextId, setIcon, type IconName } from './dom';
import { SCREEN_PRESETS, matchPreset } from './presets';

const INTRO_KEY = 'holowindow:intro-dismissed:v1';
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

function rememberIntro(): void {
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch {
    /* storage unavailable */
  }
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
    accept: 'image/*',
    class: 'hw-visually-hidden',
    tabindex: -1,
    'aria-hidden': 'true',
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handleImage(f);
    fileInput.value = '';
  });

  function handleImage(file: File): void {
    if (!file.type.startsWith('image/')) {
      setStatus(`"${file.name}" isn't an image. Try a JPG, PNG or WebP.`, 'error');
      return;
    }
    imageLoaded = true;
    if (settings.mode !== 'photo') {
      // main.ts switches mode itself in onImage; mirror it locally so the toggle is right.
      settings = { ...settings, mode: 'photo' };
      syncAll();
    }
    cb.onImage(file);
  }

  // ---------------------------------------------------------------- dock
  const modeSeg = segmented<Mode>(
    'Scene',
    [
      { value: 'room', text: 'Room', icon: 'room' },
      { value: 'photo', text: 'Photo', icon: 'photo' },
    ],
    (s) => s.mode,
    (v) => setMode(v),
  );
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
    { type: 'button', class: 'hw-btn hw-btn-accent', title: 'Upload an image (or drop one anywhere)', onclick: () => fileInput.click() },
    icon('upload'),
    h('span', { class: 'hw-label' }, 'Upload image'),
  );
  const recenterBtn = iconButton('recenter', 'Recenter', () => recenter(), 'R');
  const fsBtn = iconButton('fullscreen', 'Enter fullscreen', () => cb.onToggleFullscreen(), 'F');
  const settingsBtn = iconButton('settings', 'Settings', () => toggleSettings());

  const dock = h(
    'div',
    { class: 'hw-dock hw-glass', role: 'toolbar', 'aria-label': 'HoloWindow controls' },
    modeSeg,
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
        h('legend', {}, 'Your screen'),
        h('div', { class: 'hw-field' }, h('label', { for: presetId }, 'Preset'), presetSelect),
        h(
          'div',
          { class: 'hw-row' },
          numberInput('Width', (s) => s.screen.widthCm, (v) => commit({ screen: { ...settings.screen, widthCm: v } })),
          numberInput('Height', (s) => s.screen.heightCm, (v) => commit({ screen: { ...settings.screen, heightCm: v } })),
        ),
        h(
          'p',
          { class: 'hw-hint' },
          'Measure the lit area of the display (not the bezel) with a ruler. Accurate size is what makes the illusion line up.',
        ),
      ),
      h(
        'fieldset',
        { class: 'hw-group' },
        h('legend', {}, 'Tracking'),
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
        h('legend', {}, 'Photo'),
        slider({
          label: 'Depth',
          min: 2,
          max: 40,
          step: 0.5,
          get: (s) => s.depthScale,
          set: (v) => commit({ depthScale: v }),
          format: (v) => `${v.toFixed(1)} cm`,
          hint: 'How far the photo relief extends into the screen.',
        }),
      ),
      h(
        'div',
        { class: 'hw-switch-row' },
        h('label', { for: debugId }, 'Debug overlay', h('span', { class: 'hw-hint' }, 'Webcam preview, head position, FPS')),
        debugToggle,
      ),
      h(
        'dl',
        { class: 'hw-keys', 'aria-label': 'Keyboard shortcuts' },
        ...(
          [
            ['H', 'Hide / show controls'],
            ['F', 'Fullscreen'],
            ['R', 'Recenter'],
            ['Space', 'Switch Room / Photo'],
          ] as const
        ).flatMap(([k, d]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, d)]),
      ),
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
        onclick: () => {
          closeIntro();
          settings = { ...settings, source: 'face' };
          syncAll();
          cb.onStartCamera();
        },
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
        h('p', { class: 'hw-hint' }, 'Tip: close one eye. It looks even more real.'),
      ),
    );
    root.appendChild(introEl);
    introOpen = true;
    requestAnimationFrame(() => enableBtn.focus());
    // Simple focus trap between the two buttons.
    introEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const first = enableBtn;
      const last = mouseBtn;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // ---------------------------------------------------------------- drag & drop
  const dropOverlay = h(
    'div',
    { class: 'hw-drop', 'aria-hidden': 'true' },
    h('div', { class: 'hw-drop-inner' }, icon('photo'), h('p', {}, 'Drop an image to make it 3D')),
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
    const img = files.find((f) => f.type.startsWith('image/'));
    if (img) handleImage(img);
    else if (files.length) setStatus('That file isn’t an image. Try a JPG, PNG or WebP.', 'error');
  });

  // ---------------------------------------------------------------- auto-hide & keyboard
  let manuallyHidden = false;
  let idleTimer = 0;
  let pointerInChrome = false;

  function applyVisibility(idle: boolean): void {
    const hide = manuallyHidden || (idle && !settingsOpen && !pointerInChrome && !chrome.contains(document.activeElement));
    chrome.classList.toggle('is-hidden', hide);
    document.documentElement.classList.toggle('hw-idle', hide && !introOpen);
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
    if (mode === 'photo' && !imageLoaded) setStatus('Drop an image anywhere, or press Upload image.', 'info');
  }
  function recenter(): void {
    cb.onRecenter();
    setStatus('Recentered.', 'ok');
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && settingsOpen) {
      toggleSettings(false);
      return;
    }
    if (introOpen) return;
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
        setMode(settings.mode === 'room' ? 'photo' : 'room');
        break;
      default:
        return;
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

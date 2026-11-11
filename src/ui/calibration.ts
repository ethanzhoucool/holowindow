import { DEFAULT_POSE, type HeadPose, type ScreenSpec, type Settings } from '../types';
import { h, icon, nextId, trapTab } from './dom';

/** ISO/IEC 7810 ID-1 (credit card, most ID cards). */
const CARD_W_CM = 8.56;
const CARD_H_CM = 5.398;
const CARD_RATIO = CARD_H_CM / CARD_W_CM;
const CARD_RADIUS_CM = 0.318;
const CM_PER_IN = 2.54;

const MIN_CARD_PX = 120;
const TYPICAL_NEAR_CM = 40;
const TYPICAL_FAR_CM = 80;
const GAUGE_MAX_CM = 120;
const POSE_INTERVAL_MS = 150;

const round1 = (v: number): number => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function screenPx(): { w: number; h: number } {
  return { w: window.screen.width || window.innerWidth, h: window.screen.height || window.innerHeight };
}

function screenFromCard(cardPx: number): ScreenSpec {
  const k = CARD_W_CM / cardPx;
  const { w, h: hh } = screenPx();
  return { widthCm: round1(w * k), heightCm: round1(hh * k) };
}

function screenFromDiagonal(inches: number): ScreenSpec {
  const { w, h: hh } = screenPx();
  const k = (inches * CM_PER_IN) / Math.hypot(w, hh);
  return { widthCm: round1(w * k), heightCm: round1(hh * k) };
}

export function diagonalIn(s: ScreenSpec): number {
  return Math.hypot(s.widthCm, s.heightCm) / CM_PER_IN;
}

function aspectLabel(w: number, hh: number): string {
  const r = Math.max(w, hh) / Math.min(w, hh);
  const known: [number, number][] = [[16, 9], [16, 10], [3, 2], [4, 3], [5, 4], [21, 9], [19.5, 9], [32, 9]];
  for (const [a, b] of known) if (Math.abs(r - a / b) < 0.015) return `${a}:${b}`;
  return `${r.toFixed(2)}:1`;
}

export interface CalibrationDeps {
  getSettings(): Settings;
  /** User pressed Save. */
  onSave(screen: ScreenSpec): void;
  /** Live webcam FOV changes from the distance step. */
  onFov(deg: number): void;
  onStartCamera(): void;
  isCameraLive(): boolean;
  onClose(saved: boolean): void;
}

export interface CalibrationWizard {
  readonly el: HTMLElement;
  open(returnFocus?: HTMLElement | null): void;
  /** Close without saving (reverts any FOV change). */
  cancel(): void;
  isOpen(): boolean;
  /** Feed every frame; throttled internally. */
  updatePose(pose: HeadPose): void;
  /** Tab trapping for the global keydown handler. */
  trap(e: KeyboardEvent): void;
}

export function createCalibrationWizard(deps: CalibrationDeps): CalibrationWizard {
  let isOpenNow = false;
  let step: 1 | 2 = 1;
  let method: 'card' | 'diagonal' = 'card';
  let cardPx = 320;
  let maxCardPx = 600;
  let vertical = false;
  let diagIn = 14;
  let fovAtOpen = 60;
  let returnTo: HTMLElement | null = null;
  let fovRevealed = false;
  let lastPoseWrite = 0;
  let lastDistanceMsg = '';
  let cameraRequested = false;

  const pending = (): ScreenSpec => (method === 'card' ? screenFromCard(cardPx) : screenFromDiagonal(diagIn));
  const describe = (s: ScreenSpec): string => `${s.widthCm.toFixed(1)} × ${s.heightCm.toFixed(1)} cm`;

  // ------------------------------------------------------------ step 1: card
  const cardLabel = h('span', { class: 'hw-card-label' }, 'ID-1 · 85.60 × 53.98 mm');
  const card = h('div', { class: 'hw-card', 'aria-hidden': 'true' }, h('span', { class: 'hw-card-chip' }), cardLabel);
  const handle = h('span', { class: 'hw-card-handle', 'aria-hidden': 'true' });
  card.appendChild(handle);
  const stage = h('div', { class: 'hw-card-stage' }, card);

  const sliderId = nextId('hw-card-size');
  const sizeSlider = h('input', { id: sliderId, type: 'range', class: 'hw-range', min: MIN_CARD_PX, max: maxCardPx, step: 0.5 });
  const nudgeBtn = (dir: -1 | 1): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'hw-btn hw-btn-small',
        'aria-label': dir < 0 ? 'Shrink outline slightly' : 'Grow outline slightly',
        onclick: () => setCardPx(cardPx + dir * 0.5),
      },
      icon(dir < 0 ? 'minus' : 'plus'),
    );
  sizeSlider.addEventListener('input', () => setCardPx(Number(sizeSlider.value)));

  const resultSize = h('strong', { class: 'hw-calib-size' });
  const resultDiag = h('span', { class: 'hw-calib-diag' });
  const result = h(
    'div',
    { class: 'hw-calib-result' },
    h('span', { class: 'hw-calib-result-label' }, 'Your screen'),
    resultSize,
    resultDiag,
  );

  const toDiagonalBtn = h(
    'button',
    { type: 'button', class: 'hw-link hw-link-small', onclick: () => setMethod('diagonal') },
    'No card? Enter your diagonal',
  );
  const cardPane = h(
    'div',
    { class: 'hw-calib-pane' },
    h(
      'p',
      { class: 'hw-calib-lede' },
      'Hold a credit card or ID card flat against the screen, tucked into the top-left corner of the outline. Drag the glowing corner (or use the slider) until the outline matches the card’s edges exactly.',
    ),
    stage,
    h(
      'div',
      { class: 'hw-field hw-calib-slider' },
      h('label', { for: sliderId }, 'Outline size'),
      h('div', { class: 'hw-calib-slider-row' }, nudgeBtn(-1), sizeSlider, nudgeBtn(1)),
    ),
    toDiagonalBtn,
  );

  // ------------------------------------------------------------ step 1: diagonal fallback
  const diagId = nextId('hw-diag');
  const diagInput = h('input', {
    id: diagId,
    type: 'number',
    class: 'hw-num hw-num-in',
    min: 5,
    max: 120,
    step: 0.1,
    inputmode: 'decimal',
  });
  diagInput.addEventListener('input', () => {
    const v = Number(diagInput.value);
    if (Number.isFinite(v) && v >= 5 && v <= 120) {
      diagIn = v;
      paintResult();
    }
  });
  diagInput.addEventListener('change', () => {
    diagInput.value = String(round1(diagIn));
  });
  const aspectNote = h('p', { class: 'hw-hint' });
  const toCardBtn = h('button', { type: 'button', class: 'hw-link hw-link-small', onclick: () => setMethod('card') }, 'Use a card instead');
  const diagPane = h(
    'div',
    { class: 'hw-calib-pane', hidden: true },
    h(
      'p',
      { class: 'hw-calib-lede' },
      'Enter your display’s diagonal (it’s on the box, the spec sheet, or try “About this Mac” / display settings).',
    ),
    h(
      'div',
      { class: 'hw-field' },
      h('label', { for: diagId }, 'Diagonal'),
      h('div', { class: 'hw-num-wrap hw-num-wrap-in' }, diagInput, h('span', { class: 'hw-unit', 'aria-hidden': 'true' }, 'in')),
      aspectNote,
    ),
    toCardBtn,
  );

  const step1 = h('div', { class: 'hw-calib-step' }, cardPane, diagPane, result);

  // ------------------------------------------------------------ step 2: distance
  const distNum = h('span', { class: 'hw-dist-num' }, '--');
  const distMarker = h('span', { class: 'hw-gauge-marker', hidden: true });
  const gauge = h(
    'div',
    { class: 'hw-gauge', 'aria-hidden': 'true' },
    h('span', {
      class: 'hw-gauge-band',
      style: `left:${(TYPICAL_NEAR_CM / GAUGE_MAX_CM) * 100}%;width:${((TYPICAL_FAR_CM - TYPICAL_NEAR_CM) / GAUGE_MAX_CM) * 100}%`,
    }),
    distMarker,
    h('span', { class: 'hw-gauge-tick', style: `left:${(TYPICAL_NEAR_CM / GAUGE_MAX_CM) * 100}%` }, `${TYPICAL_NEAR_CM}`),
    h('span', { class: 'hw-gauge-tick', style: `left:${(TYPICAL_FAR_CM / GAUGE_MAX_CM) * 100}%` }, `${TYPICAL_FAR_CM}`),
  );
  const distMsg = h('p', { class: 'hw-dist-msg', 'aria-live': 'polite' });
  const enableCamBtn = h(
    'button',
    {
      type: 'button',
      class: 'hw-btn hw-btn-outline',
      hidden: true,
      onclick: () => {
        cameraRequested = true;
        deps.onStartCamera();
        paintDistance(null);
        finishBtn.focus();
      },
    },
    icon('camera'),
    'Enable camera',
  );

  const fovId = nextId('hw-calib-fov');
  const fovOut = h('output', { class: 'hw-out', for: fovId });
  const fovSlider = h('input', { id: fovId, type: 'range', class: 'hw-range', min: 40, max: 90, step: 1 });
  const paintFov = (v: number): void => {
    fovOut.textContent = `${Math.round(v)}°`;
    fovSlider.setAttribute('aria-valuetext', `${Math.round(v)} degrees`);
    fovSlider.style.setProperty('--fill', `${((v - 40) / 50) * 100}%`);
  };
  fovSlider.addEventListener('input', () => {
    const v = Number(fovSlider.value);
    paintFov(v);
    deps.onFov(v);
  });
  const fovField = h(
    'div',
    { class: 'hw-field hw-calib-fov', hidden: true },
    h('div', { class: 'hw-field-head' }, h('label', { for: fovId }, 'Webcam field of view'), fovOut),
    fovSlider,
    h('p', { class: 'hw-hint' }, 'Wider FOV reads you as closer; narrower reads you as farther. Most laptop cameras are 55–75°.'),
  );
  const showFovBtn = h(
    'button',
    { type: 'button', class: 'hw-link hw-link-small', onclick: () => revealFov(true) },
    'Adjust webcam field of view',
  );

  const step2 = h(
    'div',
    { class: 'hw-calib-step', hidden: true },
    h(
      'p',
      { class: 'hw-calib-lede' },
      'Optional. Sit where you normally sit. If the reading below doesn’t match how far your eyes really are from the screen, tune the webcam’s field of view.',
    ),
    h(
      'div',
      { class: 'hw-dist' },
      h('span', { class: 'hw-calib-result-label' }, 'We’re reading your distance as'),
      h('div', { class: 'hw-dist-read' }, distNum, h('span', { class: 'hw-dist-unit' }, 'cm')),
      gauge,
      distMsg,
      enableCamBtn,
    ),
    fovField,
    showFovBtn,
  );

  // ------------------------------------------------------------ shell
  const titleId = nextId('hw-calib-title');
  const stepLabel = h('p', { class: 'hw-eyebrow hw-calib-eyebrow' });
  const title = h('h2', { id: titleId, class: 'hw-calib-title' });
  const dots = [h('span', { class: 'hw-calib-dot' }), h('span', { class: 'hw-calib-dot' })];

  const cancelBtn = h('button', { type: 'button', class: 'hw-link', onclick: () => cancel() }, 'Cancel');
  const backBtn = h('button', { type: 'button', class: 'hw-btn hw-btn-outline', onclick: () => goStep(1) }, icon('arrowLeft'), 'Back');
  const saveBtn = h('button', { type: 'button', class: 'hw-btn hw-btn-outline', onclick: () => save() }, 'Save');
  const nextBtn = h('button', { type: 'button', class: 'hw-btn hw-btn-primary', onclick: () => goStep(2) }, 'Next: distance', icon('arrowRight'));
  const finishBtn = h('button', { type: 'button', class: 'hw-btn hw-btn-primary', onclick: () => save() }, 'Save');
  const closeBtn = h(
    'button',
    { type: 'button', class: 'hw-btn hw-calib-close', 'aria-label': 'Close calibration', onclick: () => cancel() },
    icon('close'),
  );

  const dialog = h(
    'div',
    { class: 'hw-calib hw-glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', { class: 'hw-calib-head' }, h('div', {}, stepLabel, title), h('div', { class: 'hw-calib-dots', 'aria-hidden': 'true' }, ...dots), closeBtn),
    h('div', { class: 'hw-calib-body' }, step1, step2),
    h('footer', { class: 'hw-calib-foot' }, cancelBtn, backBtn, h('span', { class: 'hw-calib-spacer' }), saveBtn, nextBtn, finishBtn),
  );
  const el = h('div', { class: 'hw-calib-backdrop', hidden: true }, dialog);
  el.addEventListener('pointerdown', (e) => {
    if (e.target === el) cancel();
  });

  // ------------------------------------------------------------ dragging the corner
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    card.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = card.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    // Project the pointer onto the card's diagonal so the corner tracks the finger.
    const [ax, ay] = vertical ? [CARD_RATIO, 1] : [1, CARD_RATIO];
    setCardPx((dx * ax + dy * ay) / (ax * ax + ay * ay));
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('is-dragging');
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ rendering
  function setCardPx(v: number): void {
    cardPx = clamp(Math.round(v * 2) / 2, MIN_CARD_PX, maxCardPx);
    paintCard();
    paintResult();
  }

  function paintCard(): void {
    const long = cardPx;
    const short = cardPx * CARD_RATIO;
    card.style.width = `${vertical ? short : long}px`;
    card.style.height = `${vertical ? long : short}px`;
    card.style.borderRadius = `${(CARD_RADIUS_CM / CARD_W_CM) * long}px`;
    cardLabel.style.fontSize = `${clamp(long * 0.032, 6, 11)}px`;
    card.classList.toggle('is-vertical', vertical);
    if (Number(sizeSlider.value) !== cardPx) sizeSlider.value = String(cardPx);
    sizeSlider.style.setProperty('--fill', `${((cardPx - MIN_CARD_PX) / (maxCardPx - MIN_CARD_PX)) * 100}%`);
  }

  function paintResult(): void {
    const s = pending();
    const d = diagonalIn(s);
    resultSize.textContent = describe(s);
    resultDiag.textContent = `${d.toFixed(1)}″ diagonal`;
    sizeSlider.setAttribute('aria-valuetext', `Screen ${s.widthCm.toFixed(1)} by ${s.heightCm.toFixed(1)} centimetres, ${d.toFixed(1)} inch diagonal`);
  }

  function layoutCard(): void {
    vertical = window.innerWidth < 600 && window.innerHeight > window.innerWidth;
    const avail = vertical ? Math.min(window.innerHeight * 0.85, 760) : stage.clientWidth - 22;
    maxCardPx = Math.max(MIN_CARD_PX + 40, Math.floor(avail));
    sizeSlider.max = String(maxCardPx);
    setCardPx(cardPx);
  }

  function setMethod(m: 'card' | 'diagonal'): void {
    method = m;
    cardPane.hidden = m !== 'card';
    diagPane.hidden = m !== 'diagonal';
    if (m === 'card') {
      layoutCard();
      sizeSlider.focus();
    } else {
      const { w, h: hh } = screenPx();
      aspectNote.textContent = `Aspect ratio ${aspectLabel(w, hh)}, from your display’s resolution (${w} × ${hh}).`;
      diagInput.value = String(round1(diagIn));
      diagInput.focus();
    }
    paintResult();
  }

  function goStep(n: 1 | 2): void {
    step = n;
    step1.hidden = n !== 1;
    step2.hidden = n !== 2;
    backBtn.hidden = n !== 2;
    nextBtn.hidden = n !== 1;
    saveBtn.hidden = n !== 1;
    finishBtn.hidden = n !== 2;
    cancelBtn.hidden = n !== 1;
    stepLabel.textContent = `Calibrate · step ${n} of 2`;
    title.textContent = n === 1 ? 'Match your screen to a card' : 'Check your viewing distance';
    dots.forEach((d, i) => d.classList.toggle('is-on', i === n - 1));
    if (n === 1) {
      if (method === 'card') {
        layoutCard();
        sizeSlider.focus();
      } else diagInput.focus();
    } else {
      const s = deps.getSettings();
      fovSlider.value = String(s.cameraFovDeg);
      paintFov(s.cameraFovDeg);
      lastDistanceMsg = '';
      lastPoseWrite = 0;
      paintDistance(null);
      finishBtn.focus();
    }
  }

  function revealFov(focus: boolean): void {
    fovRevealed = true;
    fovField.hidden = false;
    showFovBtn.hidden = true;
    if (focus) fovSlider.focus();
  }

  function setDistanceMsg(text: string, kind: 'ok' | 'warn' | 'info'): void {
    if (text === lastDistanceMsg) return;
    lastDistanceMsg = text;
    distMsg.textContent = text;
    distMsg.dataset.kind = kind;
  }

  function paintDistance(pose: HeadPose | null): void {
    const s = deps.getSettings();
    const live = s.source === 'face' && deps.isCameraLive();
    enableCamBtn.hidden = live;
    if (!live) {
      distNum.textContent = '--';
      distMarker.hidden = true;
      // main.ts flips source back to 'mouse' if the camera fails, which re-offers the button.
      const starting = cameraRequested && s.source === 'face';
      enableCamBtn.hidden = starting;
      setDistanceMsg(
        starting ? 'Starting camera…' : 'Measuring distance needs the webcam. Turn it on, or just save to skip this step.',
        'info',
      );
      return;
    }
    if (!pose || !pose.tracked) {
      distNum.textContent = '--';
      distMarker.hidden = true;
      setDistanceMsg('Looking for your face… face the screen in good light.', 'info');
      return;
    }
    // hud.update() receives the motion-gained pose; undo the gain to show the physical reading.
    const gain = Math.max(s.motionGain, 1e-3);
    const z = DEFAULT_POSE.z + (pose.z - DEFAULT_POSE.z) / gain;
    distNum.textContent = String(Math.round(z));
    distMarker.hidden = false;
    distMarker.style.left = `${clamp(z / GAUGE_MAX_CM, 0, 1) * 100}%`;
    const inRange = z >= TYPICAL_NEAR_CM && z <= TYPICAL_FAR_CM;
    distMarker.classList.toggle('is-off', !inRange);
    if (inRange) {
      setDistanceMsg('That’s in the typical 40–80 cm range. If it matches reality, you’re all set.', 'ok');
    } else {
      const far = z > TYPICAL_FAR_CM;
      setDistanceMsg(
        far
          ? 'That’s farther than most people sit. If you’re really closer, raise the field of view until the number matches.'
          : 'That’s closer than most people sit. If you’re really farther away, lower the field of view until the number matches.',
        'warn',
      );
      if (!fovRevealed) revealFov(false);
    }
  }

  // ------------------------------------------------------------ open / close
  function open(focusBack: HTMLElement | null = null): void {
    if (isOpenNow) return;
    isOpenNow = true;
    returnTo = focusBack ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const s = deps.getSettings();
    fovAtOpen = s.cameraFovDeg;
    const { w } = screenPx();
    cardPx = CARD_W_CM / (s.screen.widthCm / w);
    diagIn = round1(diagonalIn(s.screen));
    method = 'card';
    cardPane.hidden = false;
    diagPane.hidden = true;
    fovRevealed = false;
    cameraRequested = false;
    fovField.hidden = true;
    showFovBtn.hidden = false;
    el.hidden = false;
    window.addEventListener('resize', onResize);
    goStep(1);
  }

  function onResize(): void {
    if (isOpenNow && step === 1 && method === 'card') layoutCard();
  }

  function close(saved: boolean): void {
    if (!isOpenNow) return;
    isOpenNow = false;
    dragging = false;
    el.hidden = true;
    window.removeEventListener('resize', onResize);
    deps.onClose(saved);
    if (returnTo?.isConnected) returnTo.focus();
    returnTo = null;
  }

  function cancel(): void {
    if (!isOpenNow) return;
    if (deps.getSettings().cameraFovDeg !== fovAtOpen) deps.onFov(fovAtOpen);
    close(false);
  }

  function save(): void {
    deps.onSave(pending());
    close(true);
  }

  return {
    el,
    open,
    cancel,
    isOpen: () => isOpenNow,
    updatePose(pose) {
      if (!isOpenNow || step !== 2) return;
      const now = performance.now();
      if (now - lastPoseWrite < POSE_INTERVAL_MS) return;
      lastPoseWrite = now;
      paintDistance(pose);
    },
    trap(e) {
      trapTab(dialog, e);
    },
  };
}

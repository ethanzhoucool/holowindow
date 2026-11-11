/** Tiny DOM helpers so the HUD can stay framework-free. */

import arrowCounterClockwise from '@phosphor-icons/core/assets/regular/arrow-counter-clockwise.svg?raw';
import arrowLeft from '@phosphor-icons/core/assets/regular/arrow-left.svg?raw';
import arrowRight from '@phosphor-icons/core/assets/regular/arrow-right.svg?raw';
import caretDown from '@phosphor-icons/core/assets/regular/caret-down.svg?raw';
import check from '@phosphor-icons/core/assets/regular/check.svg?raw';
import cornersIn from '@phosphor-icons/core/assets/regular/corners-in.svg?raw';
import cornersOut from '@phosphor-icons/core/assets/regular/corners-out.svg?raw';
import creditCard from '@phosphor-icons/core/assets/regular/credit-card.svg?raw';
import crosshairSimple from '@phosphor-icons/core/assets/regular/crosshair-simple.svg?raw';
import cube from '@phosphor-icons/core/assets/regular/cube.svg?raw';
import fileArrowUp from '@phosphor-icons/core/assets/regular/file-arrow-up.svg?raw';
import fish from '@phosphor-icons/core/assets/regular/fish.svg?raw';
import folderOpen from '@phosphor-icons/core/assets/regular/folder-open.svg?raw';
import image from '@phosphor-icons/core/assets/regular/image.svg?raw';
import lockSimple from '@phosphor-icons/core/assets/regular/lock-simple.svg?raw';
import minus from '@phosphor-icons/core/assets/regular/minus.svg?raw';
import mouseSimple from '@phosphor-icons/core/assets/regular/mouse-simple.svg?raw';
import perspective from '@phosphor-icons/core/assets/regular/perspective.svg?raw';
import planet from '@phosphor-icons/core/assets/regular/planet.svg?raw';
import plus from '@phosphor-icons/core/assets/regular/plus.svg?raw';
import slidersHorizontal from '@phosphor-icons/core/assets/regular/sliders-horizontal.svg?raw';
import userFocus from '@phosphor-icons/core/assets/regular/user-focus.svg?raw';
import warningCircle from '@phosphor-icons/core/assets/regular/warning-circle.svg?raw';
import webcam from '@phosphor-icons/core/assets/regular/webcam.svg?raw';
import x from '@phosphor-icons/core/assets/regular/x.svg?raw';

type AttrValue = string | number | boolean | null | undefined | ((ev: never) => void);
export type Attrs = Record<string, AttrValue>;
export type Child = Node | string | null | undefined | false;

let uid = 0;
/** Unique id for label/aria wiring. */
export function nextId(prefix = 'hw'): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

/** Phosphor icons (regular weight only), inlined as raw SVG so they inherit `currentColor`. */
const ICONS = {
  room: perspective,
  space: planet,
  aquarium: fish,
  model: cube,
  photo: image,
  card: creditCard,
  reset: arrowCounterClockwise,
  chevronDown: caretDown,
  arrowLeft,
  arrowRight,
  minus,
  plus,
  face: userFocus,
  mouse: mouseSimple,
  open: folderOpen,
  file: fileArrowUp,
  recenter: crosshairSimple,
  fullscreen: cornersOut,
  exitFullscreen: cornersIn,
  settings: slidersHorizontal,
  close: x,
  camera: webcam,
  lock: lockSimple,
  check,
  warning: warningCircle,
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): HTMLSpanElement {
  const span = h('span', { class: 'hw-icon', 'aria-hidden': 'true' });
  span.innerHTML = ICONS[name];
  return span;
}

export function setIcon(span: HTMLElement, name: IconName): void {
  span.innerHTML = ICONS[name];
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Visible, focusable descendants of `root`, in DOM order. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

/** Keeps Tab / Shift+Tab cycling inside `root`. Call from a keydown handler. */
export function trapTab(root: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const items = focusableIn(root);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

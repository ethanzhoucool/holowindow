/** Tiny DOM helpers so the HUD can stay framework-free. */

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

const ICONS = {
  room: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 15.5-4.5-4.5L7 20"/>',
  face: '<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  upload: '<path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  recenter: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.2"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  exitFullscreen: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  settings:
    '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  camera: '<path d="M15 10.5 20 7v10l-5-3.5"/><rect x="3" y="6" width="12" height="12" rx="2.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): HTMLSpanElement {
  const span = h('span', { class: 'hw-icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

export function setIcon(span: HTMLElement, name: IconName): void {
  const svg = span.querySelector('svg');
  if (svg) svg.innerHTML = ICONS[name];
}

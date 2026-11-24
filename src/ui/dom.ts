export type Child = Node | string | number | false | null | undefined;
export type Props = Record<string, any>;

export function h<T extends HTMLElement = HTMLDivElement>(tag: string, props: Props = {}, ...children: any[]): T {
  // 兼容项目里使用的 `div.page guide-page`：空格后的裸类名也转成 .class。
  const normalizedTag = tag.trim().replace(/\s+/g, '.');
  const tagName = normalizedTag.split(/[.#]/)[0] || 'div';
  const id = normalizedTag.match(/#([\w-]+)/)?.[1];
  const classes = Array.from(normalizedTag.matchAll(/\.([\w-]+)/g), (m) => m[1]);
  const el = document.createElement(tagName) as T;
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') el.className = `${el.className} ${value}`.trim();
    else if (key === 'style' && typeof value === 'string') el.setAttribute('style', value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'html') el.innerHTML = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in el && key !== 'list' && typeof value !== 'object') {
      try {
        (el as any)[key] = value;
      } catch {
        el.setAttribute(key, String(value));
      }
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity) as any[]) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function toast(message: string, type: 'info' | 'success' | 'error' = 'info', timeout = 2600): void {
  let host = document.querySelector<HTMLDivElement>('.toast-host');
  if (!host) {
    host = h<HTMLDivElement>('div.toast-host');
    document.body.appendChild(host);
  }
  const item = h<HTMLDivElement>(`div.toast.toast-${type}`, {}, message);
  host.appendChild(item);
  setTimeout(() => {
    item.classList.add('toast-leave');
    setTimeout(() => item.remove(), 260);
  }, timeout);
}

export function downloadText(fileName: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}

export function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function mm(n: number, digits = 0): string {
  return `${n.toFixed(digits)} mm`;
}

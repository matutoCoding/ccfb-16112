import { h, type Child } from './dom';

export function Card(title: string, body: Child, actions?: Child, className = ''): HTMLElement {
  return h(`section.card ${className}`, {}, [
    h('header.card-header', {}, [h('h2', {}, title), actions ? h('div.card-actions', {}, actions) : null]),
    h('div.card-body', {}, body)
  ]);
}

export function Stat(label: string, value: string, tone: 'good' | 'warn' | 'bad' | 'info' = 'info', sub?: string): HTMLElement {
  return h(`div.stat stat-${tone}`, {}, [
    h('div.stat-value', {}, value),
    h('div.stat-label', {}, label),
    sub ? h('div.stat-sub', {}, sub) : null
  ]);
}

export function Badge(text: string, tone: 'good' | 'warn' | 'bad' | 'info' | 'muted' = 'info'): HTMLElement {
  return h(`span.badge badge-${tone}`, {}, text);
}

export function NumberRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  onChange: (v: number) => void
): HTMLElement {
  const input = h<HTMLInputElement>('input', {
    type: 'number',
    value: Number.isFinite(value) ? String(Number(value.toFixed(3))) : '0',
    min: String(min),
    max: String(max),
    step: String(step),
    onchange: () => {
      const v = Number.parseFloat(input.value);
      if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
    }
  });
  return h('label.field-number', {}, [
    h('span', {}, label),
    h('span.field-input', {}, [input, h('em', {}, unit)])
  ]);
}

export function RangeRow(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  display: string,
  onChange: (v: number) => void
): HTMLElement {
  const range = h<HTMLInputElement>('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    oninput: () => {
      const v = Number.parseFloat(range.value);
      valueLabel.textContent = display.replace('{v}', String(v));
      onChange(v);
    }
  });
  const valueLabel = h('b.range-value', {}, display.replace('{v}', String(value)));
  return h('label.field-range', {}, [h('span', {}, [label, valueLabel]), range]);
}

export function SelectRow<T extends string>(
  label: string,
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (v: T) => void
): HTMLElement {
  const select = h<HTMLSelectElement>('select', {
    onchange: () => onChange(select.value as T)
  }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  select.value = value;
  return h('label.field-select', {}, [h('span', {}, label), select]);
}

export function CheckRow(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  const input = h<HTMLInputElement>('input', {
    type: 'checkbox',
    checked,
    onchange: () => onChange(input.checked)
  });
  return h('label.field-check', {}, [input, h('span', {}, [label, hint ? h('em', {}, hint) : null])]);
}

export function EmptyHint(text: string): HTMLElement {
  return h('div.empty-hint', {}, text);
}

export function progressBar(value: number, tone?: string): HTMLElement {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return h('div.progress', {}, h(`i.progress-bar ${tone ?? ''}`, { style: `width:${pct.toFixed(1)}%` }));
}

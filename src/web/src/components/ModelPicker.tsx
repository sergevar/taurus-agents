import { useEffect, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { api } from '../api';
import { fmtTokens } from '../utils/format';

interface ModelPricing {
  input: number;
  output: number;
}

interface ModelInfo {
  id: string;
  title: string;
  description: string;
  contextTokens: number;
  maxOutputTokens: number;
  pricing?: ModelPricing;
}

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  placeholder?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
};

function providerLabel(key: string): string {
  return PROVIDER_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Map a model ID to its provider icon filename. */
function modelIcon(id: string): string {
  const provider = id.split('/')[0];
  if (provider !== 'openrouter') return `/icons/${provider}.png`;
  // OpenRouter: check sub-provider for known icons
  const sub = id.split('/')[1] ?? '';
  if (sub === 'google') return '/icons/gemini.png';
  if (sub === 'x-ai') return '/icons/grok.png';
  return '/icons/openrouter.png';
}

/** Format pricing as compact "$in / $out" per MTok. */
function fmtPrice(p: ModelPricing): string {
  return `$${p.input} / $${p.output}`;
}

/** Highlight matching substring in text with a <mark>. */
function highlight(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="model-picker__match">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function ModelPicker({ value, onChange, placeholder }: ModelPickerProps) {
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({});
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(-1);
  // Value when dropdown opened — for Escape revert
  const valueOnOpenRef = useRef('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listModels().then(setModels).catch(() => {});
  }, []);

  // Click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Filter models by partial match on id or title
  const q = filter.toLowerCase();
  const filtered: Record<string, ModelInfo[]> = {};
  for (const [provider, list] of Object.entries(models)) {
    const matches = q
      ? list.filter(m => m.id.toLowerCase().includes(q) || m.title.toLowerCase().includes(q))
      : list;
    if (matches.length > 0) filtered[provider] = matches;
  }

  // Flat list of filtered model IDs for arrow key navigation
  const flatIds = Object.values(filtered).flat().map(m => m.id);

  // Reset highlight when filter changes
  useEffect(() => { setHighlightIdx(-1); }, [filter]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (highlightIdx < 0 || !dropdownRef.current) return;
    const el = dropdownRef.current.querySelector(`[data-idx="${highlightIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx]);

  function handleOpen() {
    valueOnOpenRef.current = value;
    setOpen(true);
    setFilter('');
    setHighlightIdx(-1);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setFilter(v);
    onChange(v);
    if (!open) {
      valueOnOpenRef.current = value;
      setOpen(true);
    }
  }

  function handleSelect(id: string) {
    onChange(id);
    setFilter('');
    setOpen(false);
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange('');
    setFilter('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      handleOpen();
      return;
    }
    if (!open) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(i => (i < flatIds.length - 1 ? i + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(i => (i > 0 ? i - 1 : flatIds.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < flatIds.length) {
        handleSelect(flatIds[highlightIdx]);
      } else if (flatIds.length === 1) {
        handleSelect(flatIds[0]);
      } else {
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onChange(valueOnOpenRef.current);
      setFilter('');
      setOpen(false);
    }
  }

  const placeholderText = placeholder ?? '';

  // Build flat index counter for data-idx
  let flatCounter = 0;

  return (
    <div className="model-picker" ref={ref}>
      <div className={`model-picker__trigger ${open ? 'model-picker__trigger--open' : ''}`} onClick={() => !open && handleOpen()}>
        <input
          ref={inputRef}
          type="text"
          className="model-picker__input"
          value={open ? (filter || value) : value}
          onChange={handleInputChange}
          onBlur={() => setTimeout(() => { if (!ref.current?.contains(document.activeElement)) { setOpen(false); setFilter(''); } }, 0)}
          onKeyDown={handleKeyDown}
          placeholder={placeholderText}
        />
        <span className="model-picker__trigger-icons">
          {value && (
            <span className="model-picker__clear" onClick={handleClear} title="Clear selection">
              <X size={13} />
            </span>
          )}
          <ChevronDown size={14} className={`model-picker__chevron ${open ? 'model-picker__chevron--open' : ''}`} />
        </span>
      </div>

      {open && (
        <div className="model-picker__dropdown" ref={dropdownRef} tabIndex={-1}>
          {Object.keys(filtered).length === 0 && (
            <div className="model-picker__empty">No models match</div>
          )}
          {Object.entries(filtered).map(([provider, list]) => (
            <div key={provider} className="model-picker__group" data-provider={provider}>
              <div className="model-picker__group-label">{providerLabel(provider)}</div>
              {list.map(m => {
                const idx = flatCounter++;
                return (
                  <button
                    key={m.id}
                    type="button"
                    tabIndex={-1}
                    data-idx={idx}
                    className={`model-picker__option${m.id === value ? ' model-picker__option--selected' : ''}${idx === highlightIdx ? ' model-picker__option--highlighted' : ''}`}
                    onClick={() => handleSelect(m.id)}
                  >
                    <img className="model-picker__icon" src={modelIcon(m.id)} alt="" />
                    <span className="model-picker__option-body">
                      <span className="model-picker__option-row">
                        <span className="model-picker__option-title">{highlight(m.title, q)}</span>
                        <span className="model-picker__option-id">{highlight(m.id, q)}</span>
                      </span>
                      <span className="model-picker__option-row2">
                        <span className="model-picker__option-meta">
                          {m.pricing && <span className="model-picker__price">{fmtPrice(m.pricing)}</span>}
                          <span className="model-picker__badge">{fmtTokens(m.contextTokens)} ctx</span>
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

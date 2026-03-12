import { fmtTokens } from '../utils/format';

interface ContextRingProps {
  /** Tokens used (input + visible output of last turn) */
  used: number;
  /** Model's context window limit */
  limit: number;
  /** Ring diameter in px */
  size?: number;
}

/**
 * Tiny ring chart showing context window usage %.
 * Hover tooltip shows exact numbers.
 */
export function ContextRing({ used, limit, size = 16 }: ContextRingProps) {
  if (!limit || limit <= 0) return null;

  const pct = Math.min(used / limit, 1);
  const pctDisplay = Math.round(pct * 100);
  const remaining = Math.max(0, Math.round((1 - pct) * 100));

  // SVG ring params
  const r = (size - 2) / 2; // leave 1px padding
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - pct);

  // Color: green → amber → red
  const color = pct < 0.6 ? 'var(--c-muted)' : pct < 0.85 ? '#D4A574' : '#E06C75';

  const tooltip = `${pctDisplay}% context used\n${fmtTokens(used)} / ${fmtTokens(limit)}\n${remaining}% remaining`;

  return (
    <span className="context-ring" title={tooltip}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background track */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          opacity={0.15}
        />
        {/* Filled arc */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </svg>
      <span className="context-ring__label">{pctDisplay}%</span>
    </span>
  );
}

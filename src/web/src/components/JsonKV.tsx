/**
 * Renders JSON data as a compact key-value table with recursive nesting.
 * Objects → table rows, arrays → numbered items, primitives → inline values.
 * All values are rendered via React JSX (auto-escaped, safe from injection).
 */

interface JsonKVProps {
  data: unknown;
}

export function JsonKV({ data }: JsonKVProps) {
  return <Value data={data} depth={0} />;
}

function Value({ data, depth }: { data: unknown; depth: number }) {
  if (data === null || data === undefined) {
    return <span className="json-kv__null">null</span>;
  }

  if (typeof data === 'boolean') {
    return <span className="json-kv__bool">{String(data)}</span>;
  }

  if (typeof data === 'number') {
    return <span className="json-kv__num">{data}</span>;
  }

  if (typeof data === 'string') {
    // Multiline or long strings → pre block
    if (data.includes('\n') || data.length > 200) {
      return <pre className="json-kv__pre">{data}</pre>;
    }
    return <span className="json-kv__str">{data}</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="json-kv__null">[]</span>;

    // Simple arrays (all primitives, short) → inline
    if (data.length <= 5 && data.every(v => typeof v !== 'object' || v === null)) {
      return (
        <span className="json-kv__inline-array">
          {data.map((item, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <Value data={item} depth={depth} />
            </span>
          ))}
        </span>
      );
    }

    // Complex arrays → numbered rows
    return (
      <table className="json-kv__table">
        <tbody>
          {data.map((item, i) => (
            <tr key={i}>
              <td className="json-kv__key">{i}</td>
              <td className="json-kv__val"><Value data={item} depth={depth + 1} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="json-kv__null">{'{}'}</span>;

    return (
      <table className="json-kv__table">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <td className="json-kv__key">{key}</td>
              <td className="json-kv__val"><Value data={value} depth={depth + 1} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // Fallback
  return <span>{String(data)}</span>;
}

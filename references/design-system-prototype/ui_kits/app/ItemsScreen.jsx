/* All items — data table with rules, tabular columns, status chips. */

function StatusChip({ status }) {
  if (status === 'known')  return <Chip tone="success" dot>Known</Chip>;
  if (status === 'lapsed') return <Chip tone="error" dot>Lapsed</Chip>;
  return <Chip tone="primary" dot>Due</Chip>;
}

function ItemsScreen({ items, onAdd }) {
  useIcons();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');

  const filtered = items.filter((it) => {
    const matchQ = !q || (it.front + ' ' + it.tag).toLowerCase().includes(q.toLowerCase());
    const matchF = filter === 'all'
      || (filter === 'due' && it.status === 'due')
      || (filter === 'nosrc' && !it.source);
    return matchQ && matchF;
  });

  const Th = ({ children, align }) => (
    <th style={{ fontSize: 12, fontWeight: 560, letterSpacing: '.02em', color: 'var(--steel-muted)',
      textAlign: align || 'left', padding: '10px 16px', background: 'var(--steel-page)',
      borderBottom: '1px solid var(--steel-line-strong)', whiteSpace: 'nowrap' }}>{children}</th>
  );
  const Td = ({ children, align, mono }) => (
    <td className={mono ? 'num' : ''} style={{ padding: '13px 16px', borderBottom: '1px solid var(--steel-line)',
      textAlign: align || 'left', fontSize: 14, color: 'var(--steel-ink)', verticalAlign: 'middle' }}>{children}</td>
  );

  return (
    <div style={{ maxWidth: 940, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 500, letterSpacing: '-0.011em' }}>All items</h1>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--steel-muted)' }}>
            <span className="num">{items.length}</span> items · <span className="num">{items.filter(i => !i.source).length}</span> without a source
          </p>
        </div>
        <button className="btn btn-primary" onClick={onAdd}><Icon name="plus" size={16} /> Add item</button>
      </div>

      {/* controls */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          <Icon name="search" size={16} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--steel-faint)' }} />
          <input className="field" placeholder="Search items…" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 34 }} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[['all','All'],['due','Due'],['nosrc','No source']].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className="btn btn-sm"
              style={{ background: filter === k ? 'var(--primary-soft)' : '#fff',
                color: filter === k ? 'var(--primary-ink)' : 'var(--steel-muted)',
                border: '1px solid', borderColor: filter === k ? 'transparent' : 'var(--steel-line-strong)',
                fontWeight: filter === k ? 500 : 400 }}>{l}</button>
          ))}
        </div>
      </div>

      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>
            <Th>Item</Th><Th>Tag</Th><Th>Status</Th>
            <Th align="right">Reps</Th><Th align="right">Interval</Th><Th align="right">Retention</Th><Th>Source</Th>
          </tr></thead>
          <tbody>
            {filtered.map((it) => (
              <tr key={it.id}>
                <Td><span style={{ fontWeight: 500 }}>{it.front}</span></Td>
                <Td><Chip tone={TAG_TONES[it.tag] || 'neutral'}>{it.tag}</Chip></Td>
                <Td><StatusChip status={it.status} /></Td>
                <Td align="right" mono>{it.reps}</Td>
                <Td align="right" mono>{it.interval}</Td>
                <Td align="right" mono>{it.retention}%</Td>
                <Td>{it.source
                  ? <span style={{ fontSize: 13, color: 'var(--steel-muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="link" size={13} /> {it.source}</span>
                  : <span style={{ fontSize: 13, color: 'var(--accent-ink)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="alert-triangle" size={13} /> None</span>}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div style={{ padding: '36px 24px', textAlign: 'center', color: 'var(--steel-muted)', fontSize: 14 }}>
            No items match. <button onClick={() => { setQ(''); setFilter('all'); }} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 14, fontWeight: 500 }}>Clear filters</button>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { ItemsScreen });

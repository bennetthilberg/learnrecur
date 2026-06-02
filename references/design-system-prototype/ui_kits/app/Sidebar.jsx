/* Sidebar (wide) + tab bar (narrow) navigation. */

function NavList({ route, setRoute, dueCount, orientation }) {
  const items = [
    { key: 'review', label: 'Review', icon: 'layers' },
    { key: 'items', label: 'All items', icon: 'list' },
    { key: 'sources', label: 'Sources', icon: 'link' },
    { key: 'stats', label: 'Stats', icon: 'bar-chart-3' },
    { key: 'settings', label: 'Settings', icon: 'settings' },
  ];
  const isTabs = orientation === 'tabs';
  return (
    <React.Fragment>
      {items.map((it) => {
        const active = route === it.key;
        return (
          <button
            key={it.key}
            onClick={() => setRoute(it.key)}
            className="nav-item"
            data-active={active}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: isTabs ? '8px 12px' : '9px 11px',
              borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer',
              background: active ? 'var(--primary-soft)' : 'transparent',
              color: active ? 'var(--primary-ink)' : 'var(--steel-muted)',
              fontSize: 14, fontWeight: active ? 500 : 400,
              width: isTabs ? 'auto' : '100%', whiteSpace: 'nowrap',
              transition: 'background .14s, color .14s',
            }}
            onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'var(--steel-fill)'; e.currentTarget.style.color = 'var(--steel-ink)'; } }}
            onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--steel-muted)'; } }}
          >
            <Icon name={it.icon} size={18} style={{ flex: 'none' }} />
            {it.label}
            {it.key === 'review' && dueCount > 0 && (
              <span className="num" style={{ marginLeft: isTabs ? 6 : 'auto',
                background: 'var(--primary)', color: '#fff', fontSize: 11, fontWeight: 500,
                padding: '1px 7px', borderRadius: 999 }}>{dueCount}</span>
            )}
          </button>
        );
      })}
    </React.Fragment>
  );
}

function Sidebar({ route, setRoute, dueCount, onAdd }) {
  useIcons();
  return (
    <aside className="sidebar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px 18px' }}>
        <img src={(window.__resources && window.__resources.logoMark) || "../../assets/logo-mark.svg"} alt="" style={{ width: 30, height: 30 }} />
        <span style={{ fontSize: 17, fontWeight: 500, letterSpacing: '-0.011em' }}>
          Learn<span style={{ color: 'var(--primary)' }}>Recur</span>
        </span>
      </div>

      <button className="btn btn-primary" onClick={onAdd} style={{ justifyContent: 'center', marginBottom: 18 }}>
        <Icon name="plus" size={16} /> Add item
      </button>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <NavList route={route} setRoute={setRoute} dueCount={dueCount} orientation="sidebar" />
      </nav>

      <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 8px 4px',
        borderTop: '1px solid var(--steel-line)' }}>
        <div style={{ width: 30, height: 30, borderRadius: 999, background: 'var(--primary-soft)',
          color: 'var(--primary-ink)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 560, flex: 'none' }}>RK</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Rae Kim</div>
          <div style={{ fontSize: 12, color: 'var(--steel-faint)' }}>Free plan</div>
        </div>
      </div>
    </aside>
  );
}

function TabBar({ route, setRoute, dueCount, onAdd }) {
  useIcons();
  return (
    <div className="tabbar">
      <NavList route={route} setRoute={setRoute} dueCount={dueCount} orientation="tabs" />
      <button className="btn btn-primary btn-sm" onClick={onAdd} style={{ marginLeft: 'auto' }}>
        <Icon name="plus" size={15} />
      </button>
    </div>
  );
}

Object.assign(window, { Sidebar, TabBar });

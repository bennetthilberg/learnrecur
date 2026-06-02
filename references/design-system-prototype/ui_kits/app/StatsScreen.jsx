/* Stats — retention, due forecast, streak. Quiet, scientific. */

function Stat({ label, value, unit, sub }) {
  return (
    <div className="panel" style={{ padding: 20 }}>
      <div className="eyebrow" style={{ marginBottom: 10 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span className="num" style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.011em' }}>{value}</span>
        {unit && <span className="num" style={{ fontSize: 16, color: 'var(--steel-faint)' }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--steel-muted)', marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function StatsScreen() {
  useIcons();
  // 7-day forecast of due items
  const forecast = [
    { d: 'Mon', n: 12 }, { d: 'Tue', n: 8 }, { d: 'Wed', n: 19 },
    { d: 'Thu', n: 6 }, { d: 'Fri', n: 14 }, { d: 'Sat', n: 3 }, { d: 'Sun', n: 9 },
  ];
  const max = Math.max(...forecast.map((f) => f.n));

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', width: '100%' }}>
      <h1 style={{ margin: '0 0 18px', fontSize: 26, fontWeight: 500, letterSpacing: '-0.011em' }}>Stats</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 14 }}>
        <Stat label="Retention (30d)" value="92" unit="%" sub="+1.4 pts vs. prior month" />
        <Stat label="Reviews today" value="18" sub="of 27 scheduled" />
        <Stat label="Current streak" value="46" unit="days" sub="Longest: 71" />
        <Stat label="Mature items" value="214" sub="interval ≥ 21d" />
      </div>

      <div className="panel" style={{ padding: 22 }}>
        <div className="eyebrow" style={{ marginBottom: 18 }}>Due in the next 7 days</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 150 }}>
          {forecast.map((f) => (
            <div key={f.d} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: '100%', justifyContent: 'flex-end' }}>
              <span className="num" style={{ fontSize: 12, color: 'var(--steel-muted)' }}>{f.n}</span>
              <div style={{ width: '100%', maxWidth: 46, height: `${(f.n / max) * 100}%`,
                background: f.d === 'Mon' ? 'var(--primary)' : 'var(--primary-soft)',
                borderRadius: '5px 5px 2px 2px', minHeight: 6 }} />
              <span style={{ fontSize: 12, color: 'var(--steel-faint)' }}>{f.d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Simple placeholder for routes not built out — honest about scope. */
function Placeholder({ title, note }) {
  useIcons();
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
      <h1 style={{ margin: '0 0 18px', fontSize: 26, fontWeight: 500, letterSpacing: '-0.011em' }}>{title}</h1>
      <div className="panel" style={{ padding: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <Icon name="construction" size={20} style={{ color: 'var(--steel-faint)' }} />
          <span style={{ fontSize: 17, fontWeight: 500 }}>Not in this kit</span>
        </div>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--steel-muted)', lineHeight: 1.55 }}>{note}</p>
      </div>
    </div>
  );
}

Object.assign(window, { StatsScreen, Placeholder });

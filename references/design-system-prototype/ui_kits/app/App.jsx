/* App shell — holds state, routes between screens, owns the add dialog + toast. */

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 60 }}>
      <div className="panel" style={{ boxShadow: 'var(--shadow-raised)', padding: 0, overflow: 'hidden' }}>
        <Message tone={msg.tone || 'success'} title={msg.title}>{msg.body}</Message>
      </div>
    </div>
  );
}

function App() {
  const [items, setItems] = useState(SEED_ITEMS);
  const [route, setRoute] = useState('review');
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState(null);
  // freeze the review queue per session so grading doesn't reshuffle mid-review
  const [queue] = useState(() => SEED_ITEMS.filter((i) => i.due));

  useIcons();

  const flash = (t) => { setToast(t); window.clearTimeout(flash._t); flash._t = window.setTimeout(() => setToast(null), 2600); };

  const onGrade = (card, g) => {
    setItems((prev) => prev.map((it) => it.id === card.id
      ? { ...it, reps: it.reps + 1, interval: g.next, due: false, status: g.key === 'again' ? 'lapsed' : 'known' }
      : it));
    flash({ tone: g.key === 'again' ? 'warning' : 'success', title: g.key === 'again' ? 'Will repeat soon.' : 'Saved.', body: `Next review in ${g.next}.` });
  };

  const onSave = (item) => {
    setItems((prev) => [item, ...prev]);
    flash({ tone: 'success', title: 'Item added.', body: 'Scheduled for first review tomorrow.' });
  };

  const dueCount = items.filter((i) => i.due).length;

  let screen;
  if (route === 'review') screen = <ReviewScreen queue={queue} onGrade={onGrade} />;
  else if (route === 'items') screen = <ItemsScreen items={items} onAdd={() => setAddOpen(true)} />;
  else if (route === 'stats') screen = <StatsScreen />;
  else if (route === 'sources') screen = <Placeholder title="Sources" note="Source management groups items by where they came from and flags items missing a citation. Not built out in this UI kit." />;
  else screen = <Placeholder title="Settings" note="Account, scheduling algorithm, and notification preferences live here. Not built out in this UI kit." />;

  const heading = { review: 'Review', items: 'All items', stats: 'Stats', sources: 'Sources', settings: 'Settings' }[route];

  return (
    <div className="app">
      <Sidebar route={route} setRoute={setRoute} dueCount={dueCount} onAdd={() => setAddOpen(true)} />
      <TabBar route={route} setRoute={setRoute} dueCount={dueCount} onAdd={() => setAddOpen(true)} />

      <main className="main">
        {/* sticky header */}
        <header style={{ position: 'sticky', top: 0, zIndex: 4, background: 'rgba(246,248,251,0.86)',
          backdropFilter: 'blur(8px)', borderBottom: '1px solid var(--steel-line)',
          padding: '14px 30px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 500 }}>{heading}</h2>
          {route === 'review' && dueCount > 0 && (
            <Chip tone="primary" dot style={{ marginLeft: 2 }}>{dueCount} due</Chip>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-ghost btn-icon" aria-label="Search"><Icon name="search" size={18} style={{ color: 'var(--steel-muted)' }} /></button>
            <button className="btn btn-ghost btn-icon" aria-label="Notifications"><Icon name="bell" size={18} style={{ color: 'var(--steel-muted)' }} /></button>
          </div>
        </header>

        <div style={{ padding: '30px', flex: 1 }}>
          {screen}
        </div>
      </main>

      <AddItemDialog open={addOpen} onClose={() => setAddOpen(false)} onSave={onSave} />
      <Toast msg={toast} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

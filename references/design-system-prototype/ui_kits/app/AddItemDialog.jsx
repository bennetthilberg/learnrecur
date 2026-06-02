/* Add item dialog — front/back/tag/source. Shows the no-source warning live. */

function AddItemDialog({ open, onClose, onSave }) {
  useIcons();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [tag, setTag] = useState('biology');
  const [source, setSource] = useState('');

  // reset when reopened
  useEffect(() => { if (open) { setFront(''); setBack(''); setTag('biology'); setSource(''); } }, [open]);

  const save = () => {
    if (!front.trim()) return;
    onSave({
      id: newId(), front: front.trim(), back: back.trim() || '—', tag,
      reps: 0, interval: '1d', retention: 100, due: true, status: 'due',
      source: source.trim() || null,
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} label="Add item">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 21, fontWeight: 500, letterSpacing: '-0.011em' }}>Add item</h2>
        <button onClick={onClose} className="btn btn-ghost btn-icon" aria-label="Close" style={{ border: 'none' }}>
          <Icon name="x" size={18} style={{ color: 'var(--steel-muted)' }} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label className="flabel">Front <span style={{ color: 'var(--steel-faint)', fontWeight: 400 }}>· the prompt to recall</span></label>
          <input className="field" autoFocus value={front} onChange={(e) => setFront(e.target.value)} placeholder="e.g. Krebs cycle" />
        </div>
        <div>
          <label className="flabel">Back <span style={{ color: 'var(--steel-faint)', fontWeight: 400 }}>· the answer</span></label>
          <textarea className="field" rows={3} value={back} onChange={(e) => setBack(e.target.value)} placeholder="What you want to remember…" style={{ resize: 'vertical', lineHeight: 1.5 }} />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: '0 0 150px' }}>
            <label className="flabel">Tag</label>
            <select className="field" value={tag} onChange={(e) => setTag(e.target.value)} style={{ appearance: 'none', cursor: 'pointer' }}>
              {Object.keys(TAG_TONES).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label className="flabel">Source <span style={{ color: 'var(--steel-faint)', fontWeight: 400 }}>· recommended</span></label>
            <input className="field" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Book, URL, lecture…" />
          </div>
        </div>

        {!source.trim() && (
          <Message tone="warning" title="No source.">Add one so you can verify this item later.</Message>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={!front.trim()}
          style={{ opacity: front.trim() ? 1 : 0.55, cursor: front.trim() ? 'pointer' : 'not-allowed' }}>
          Add item
        </button>
      </div>
    </Modal>
  );
}

Object.assign(window, { AddItemDialog });

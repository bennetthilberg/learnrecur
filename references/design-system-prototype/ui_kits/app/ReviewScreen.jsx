/* Review screen — Khan-style exercises.
   Answer (multiple choice or free response) -> instant feedback ->
   if correct, a difficulty override (Hard / Good / Easy, defaults to Good). */

const GRADES = {
  again: { key: 'again', label: 'Again', next: '<10m' },
  hard:  { key: 'hard',  label: 'Hard',  next: '3d'  },
  good:  { key: 'good',  label: 'Good',  next: '9d'  },
  easy:  { key: 'easy',  label: 'Easy',  next: '21d' },
};

function norm(s) { return (s || '').trim().toLowerCase().replace(/[.\u3002!?,]+$/g, ''); }

/* Segmented difficulty override shown after a correct answer. */
function GradeOverride({ value, onChange }) {
  const opts = [GRADES.hard, GRADES.good, GRADES.easy];
  return (
    <div style={{ display: 'inline-flex', background: 'var(--steel-fill)', padding: 3, borderRadius: 'var(--radius)', gap: 3 }}>
      {opts.map((g) => {
        const active = value === g.key;
        return (
          <button key={g.key} onClick={() => onChange(g.key)}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
              padding: '6px 16px', border: 'none', cursor: 'pointer', borderRadius: 3,
              background: active ? '#fff' : 'transparent',
              boxShadow: active ? 'var(--shadow-soft)' : 'none',
              color: active ? 'var(--steel-ink)' : 'var(--steel-muted)',
              fontFamily: 'var(--font-sans)', transition: 'background .12s, color .12s' }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{g.label}</span>
            <span className="num" style={{ fontSize: 11, color: 'var(--steel-faint)' }}>{g.next}</span>
          </button>
        );
      })}
    </div>
  );
}

function ExerciseCard({ card, onComplete }) {
  useIcons();
  const [selected, setSelected] = useState(null);   // MC index
  const [text, setText] = useState('');             // free response
  const [submitted, setSubmitted] = useState(false);
  const [correct, setCorrect] = useState(false);
  const [grade, setGrade] = useState('good');

  const canCheck = card.kind === 'choice' ? selected !== null : text.trim().length > 0;

  const check = () => {
    if (!canCheck || submitted) return;
    const isRight = card.kind === 'choice'
      ? selected === card.correct
      : (card.accept || [card.answer]).some((a) => norm(a) === norm(text));
    setCorrect(isRight);
    setSubmitted(true);
  };

  const finish = () => onComplete(card, correct ? GRADES[grade] : GRADES.again, correct);

  // keyboard: digits pick MC option, Enter checks/continues
  useEffect(() => {
    const h = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitted ? finish() : check(); return; }
      if (!submitted && card.kind === 'choice' && ['1','2','3','4'].includes(e.key)) setSelected(+e.key - 1);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      {/* header */}
      <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--steel-line)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Chip tone={TAG_TONES[card.tag] || 'neutral'} dot>{card.tag}</Chip>
        <span style={{ fontSize: 13, color: 'var(--steel-muted)', fontWeight: 500 }}>{card.front}</span>
        <span className="num" style={{ fontSize: 12, color: 'var(--steel-faint)', marginLeft: 'auto' }}>{card.reps} reps · {card.interval}</span>
      </div>

      {/* prompt + answer area */}
      <div style={{ padding: '24px 24px 20px' }}>
        <p style={{ margin: '0 0 18px', fontSize: 19, lineHeight: 1.4, fontWeight: 500, letterSpacing: '-0.011em', color: 'var(--steel-ink)' }}>{card.question}</p>

        {card.kind === 'choice' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {card.choices.map((c, i) => {
              const isSel = selected === i;
              const isAnswer = i === card.correct;
              let bg = '#fff', border = 'var(--steel-line-strong)', fg = 'var(--steel-ink)', badge = null;
              if (!submitted) {
                if (isSel) { bg = 'var(--primary-soft)'; border = 'var(--primary)'; fg = 'var(--primary-ink)'; }
              } else {
                if (isAnswer) { bg = 'var(--success-soft)'; border = 'var(--success-line)'; fg = 'var(--success-ink)'; badge = 'check'; }
                else if (isSel) { bg = 'var(--error-soft)'; border = 'var(--error-line)'; fg = 'var(--error-ink)'; badge = 'x'; }
                else { fg = 'var(--steel-faint)'; border = 'var(--steel-line)'; }
              }
              return (
                <button key={i} disabled={submitted} onClick={() => setSelected(i)}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, textAlign: 'left',
                    padding: '12px 14px', borderRadius: 'var(--radius)', border: `1px solid ${border}`,
                    background: bg, color: fg, cursor: submitted ? 'default' : 'pointer',
                    fontFamily: 'var(--font-sans)', fontSize: 15, transition: 'background .12s, border-color .12s' }}>
                  <span className="num" style={{ width: 22, height: 22, borderRadius: 5, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 500,
                    background: isSel && !submitted ? 'var(--primary)' : 'var(--steel-fill)',
                    color: isSel && !submitted ? '#fff' : 'var(--steel-muted)' }}>{i + 1}</span>
                  <span style={{ flex: 1 }}>{c}</span>
                  {badge && <Icon name={badge === 'check' ? 'check' : 'x'} size={17} style={{ color: badge === 'check' ? 'var(--success)' : 'var(--error)', flex: 'none' }} />}
                </button>
              );
            })}
          </div>
        ) : (
          <div>
            <input className="field" autoFocus value={text} disabled={submitted}
              onChange={(e) => setText(e.target.value)} placeholder="Type your answer…"
              style={submitted ? { borderColor: correct ? 'var(--success)' : 'var(--error)',
                background: correct ? 'var(--success-soft)' : 'var(--error-soft)',
                color: correct ? 'var(--success-ink)' : 'var(--error-ink)', fontWeight: 500 } : null} />
            {submitted && !correct && (
              <p style={{ margin: '10px 0 0', fontSize: 14, color: 'var(--steel-muted)' }}>
                Answer: <span style={{ fontWeight: 500, color: 'var(--steel-ink)' }}>{card.answer}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* feedback + footer */}
      {submitted && (
        <div style={{ padding: '0 24px 18px' }}>
          <Message tone={correct ? 'success' : 'error'} title={correct ? 'Correct.' : 'Not quite.'}>
            {card.explanation}
            {card.source && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6, color: 'var(--steel-faint)', fontSize: 13 }}><Icon name="link" size={13} />{card.source}</span>}
          </Message>
        </div>
      )}

      <div style={{ padding: 16, borderTop: '1px solid var(--steel-line)' }}>
        {!submitted ? (
          <button className="btn btn-primary" onClick={check} disabled={!canCheck}
            style={{ width: '100%', justifyContent: 'center', padding: 11, opacity: canCheck ? 1 : 0.55, cursor: canCheck ? 'pointer' : 'not-allowed' }}>
            Check answer
          </button>
        ) : correct ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span className="eyebrow">Schedule</span>
              <GradeOverride value={grade} onChange={setGrade} />
            </div>
            <button className="btn btn-primary" onClick={finish} style={{ marginLeft: 'auto', padding: '10px 18px' }}>
              Continue <Icon name="arrow-right" size={16} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--steel-muted)' }}>We'll bring this back soon.</span>
            <button className="btn btn-primary" onClick={finish} style={{ marginLeft: 'auto', padding: '10px 18px' }}>
              Continue <Icon name="arrow-right" size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewScreen({ queue, onGrade }) {
  useIcons();
  const total = queue.length;
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState(total === 0);
  const [rightCount, setRightCount] = useState(0);

  if (done || total === 0) {
    const pct = total ? Math.round((rightCount / total) * 100) : 0;
    return (
      <div style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
        <div className="panel" style={{ padding: 30 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Icon name="check-circle-2" size={22} style={{ color: 'var(--success)' }} />
            <span style={{ fontSize: 21, fontWeight: 500 }}>You're all caught up</span>
          </div>
          <p style={{ margin: '0 0 18px', color: 'var(--steel-muted)', fontSize: 15, lineHeight: 1.55 }}>
            {total === 0 ? 'Nothing is due right now.' : `You answered ${rightCount} of ${total} correctly.`} Next review in 6 hours.
          </p>
          {total > 0 && <Message tone={pct >= 70 ? 'success' : 'warning'} title={`${pct}% correct`}>
            {pct >= 70 ? 'Solid session — keep the streak going.' : 'A few to revisit soon. They\'ll come back on a tighter schedule.'}
          </Message>}
        </div>
      </div>
    );
  }

  const card = queue[idx];
  const handleComplete = (c, g, wasRight) => {
    onGrade(c, g, wasRight);
    if (wasRight) setRightCount((n) => n + 1);
    if (idx + 1 >= total) { setDone(true); return; }
    setIdx((i) => i + 1);
  };
  const pct = Math.round((idx / total) * 100);

  return (
    <div style={{ maxWidth: 620, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span className="eyebrow">Practice queue</span>
        <span className="num" style={{ fontSize: 13, color: 'var(--steel-muted)' }}>{idx + 1} / {total}</span>
      </div>
      <div style={{ height: 6, background: 'var(--steel-fill)', borderRadius: 999, overflow: 'hidden', marginBottom: 18 }}>
        <div style={{ height: '100%', width: pct + '%', background: 'var(--primary)', borderRadius: 999, transition: 'width .2s cubic-bezier(.2,.6,.2,1)' }} />
      </div>

      <ExerciseCard key={card.id} card={card} onComplete={handleComplete} />

      <p style={{ textAlign: 'center', marginTop: 14, fontSize: 12, color: 'var(--steel-faint)' }}>
        {card.kind === 'choice' ? '1–4 to pick · Enter to check' : 'Enter to check'} · Enter to continue
      </p>
    </div>
  );
}

Object.assign(window, { ReviewScreen });

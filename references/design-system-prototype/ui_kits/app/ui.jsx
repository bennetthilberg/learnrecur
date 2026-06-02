/* Shared primitives + mock data for the LearnRecur app UI kit.
   Exposed on window for the other Babel scripts. */

const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;

/* Lucide icon. Renders an <i data-lucide> that the global lucide
   replaces with an <svg> after mount. useIcons() re-runs createIcons. */
function Icon({ name, size = 18, style, className }) {
  return (
    <i
      data-lucide={name}
      className={className}
      style={{ width: size, height: size, display: 'inline-flex', ...style }}
    />
  );
}
function useIcons(deps) {
  useLayoutEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });
}

function Chip({ tone = 'neutral', dot = false, children, style }) {
  const tones = {
    neutral: { bg: 'var(--steel-fill)', fg: 'var(--steel-muted)', d: 'var(--steel-faint)' },
    primary: { bg: 'var(--primary-soft)', fg: 'var(--primary-ink)', d: 'var(--primary)' },
    success: { bg: 'var(--success-soft)', fg: 'var(--success-ink)', d: 'var(--success)' },
    warning: { bg: 'var(--warning-soft)', fg: 'var(--warning-ink)', d: 'var(--warning)' },
    error:   { bg: 'var(--error-soft)', fg: 'var(--error-ink)', d: 'var(--error)' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span className="chip" style={{ background: t.bg, color: t.fg, ...style }}>
      {dot && <span className="dot" style={{ background: t.d }} />}
      {children}
    </span>
  );
}

/* Slim-stripe inline message */
function Message({ tone = 'info', title, children }) {
  const t = {
    success: { stripe: 'var(--success)', bg: 'var(--success-soft)', line: 'var(--success-line)' },
    warning: { stripe: 'var(--warning)', bg: 'var(--warning-soft)', line: 'var(--warning-line)' },
    error:   { stripe: 'var(--error)',   bg: 'var(--error-soft)',   line: 'var(--error-line)' },
    info:    { stripe: 'var(--primary)', bg: 'var(--info-soft)',    line: 'var(--info-line)' },
  }[tone];
  return (
    <div style={{ display: 'flex', gap: 11, background: t.bg, border: `1px solid ${t.line}`,
      borderRadius: 'var(--radius)', padding: '11px 13px', alignItems: 'flex-start' }}>
      <span style={{ width: 3, borderRadius: 2, background: t.stripe, alignSelf: 'stretch', flex: 'none' }} />
      <span style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--steel-ink)' }}>
        {title && <b style={{ fontWeight: 500 }}>{title} </b>}{children}
      </span>
    </div>
  );
}

/* Modal scaffold with steel scrim */
function Modal({ open, onClose, children, label }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50,
      background: 'rgba(19,26,36,0.32)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 20px' }}>
      <div role="dialog" aria-label={label} onMouseDown={(e) => e.stopPropagation()}
        className="panel" style={{ width: 'min(520px, 100%)', boxShadow: 'var(--shadow-raised)', padding: 24 }}>
        {children}
      </div>
    </div>
  );
}

/* ---- Mock data ----
   Each item is a Khan-style exercise: either multiple-choice ('choice')
   or short free-response ('input'). `explanation` shows after answering. */
const TAG_TONES = { biology: 'success', statistics: 'primary', language: 'warning', cs: 'neutral', physics: 'neutral' };

let _id = 100;
const newId = () => ++_id;

const SEED_ITEMS = [
  { id: 1, front: 'Krebs cycle', tag: 'biology', reps: 11, interval: '14d', retention: 96, due: true, source: 'Lehninger, Ch. 16', status: 'due',
    kind: 'choice',
    question: 'Which high-energy electron carriers does the Krebs cycle generate for the electron transport chain?',
    choices: ['NADH and FADH₂', 'ATP and glucose', 'Pyruvate and lactate', 'Oxygen and water'],
    correct: 0,
    explanation: 'The cycle oxidizes acetyl-CoA to CO₂, capturing energy as NADH and FADH₂ that feed the electron transport chain.' },

  { id: 2, front: "Bayes' theorem", tag: 'statistics', reps: 7, interval: '9d', retention: 91, due: true, source: null, status: 'due',
    kind: 'choice',
    question: "What does Bayes' theorem compute?",
    choices: ['The posterior probability P(A|B)', 'The arithmetic mean of A and B', 'The variance of B', 'A frequentist p-value'],
    correct: 0,
    explanation: 'P(A|B) = P(B|A)·P(A) / P(B). It gives the posterior — your updated belief in A after observing B.' },

  { id: 3, front: 'CAP theorem', tag: 'cs', reps: 4, interval: '5d', retention: 84, due: true, source: 'Brewer, 2000', status: 'due',
    kind: 'input',
    question: "C and A stand for Consistency and Availability. What does the P stand for? (one word)",
    answer: 'partition', accept: ['partition', 'partition tolerance', 'partitioning', 'partition-tolerance'],
    explanation: 'A distributed store can guarantee at most two of Consistency, Availability, and Partition tolerance.' },

  { id: 6, front: 'Amortized analysis', tag: 'cs', reps: 2, interval: '2d', retention: 71, due: true, source: null, status: 'lapsed',
    kind: 'choice',
    question: 'Amortized analysis measures…',
    choices: ['Average cost per operation over a worst-case sequence', 'The single most expensive operation', 'Total memory used by an algorithm', 'Best-case running time'],
    correct: 0,
    explanation: 'It spreads the cost of expensive operations across a sequence — via the aggregate, accounting, or potential method.' },

  { id: 4, front: '生憎 (あいにく)', tag: 'language', reps: 23, interval: '128d', retention: 99, due: false, source: null, status: 'known',
    kind: 'input',
    question: 'What does 生憎 (あいにく) mean? (one word)',
    answer: 'unfortunately', accept: ['unfortunately', 'regrettably', 'unluckily'],
    explanation: 'Adverb: "unfortunately / regrettably" — used when circumstances are inconvenient for someone.' },

  { id: 5, front: 'Lagrangian mechanics', tag: 'physics', reps: 9, interval: '21d', retention: 88, due: false, source: 'Taylor, Ch. 7', status: 'known',
    kind: 'choice',
    question: 'Lagrangian mechanics is built on which quantity?',
    choices: ['L = T − V (kinetic minus potential energy)', 'F = ma', 'E = mc²', 'PV = nRT'],
    correct: 0,
    explanation: 'It reformulates classical mechanics via the Lagrangian L = T − V and the Euler–Lagrange equations.' },
];

Object.assign(window, { Icon, useIcons, Chip, Message, Modal, TAG_TONES, SEED_ITEMS, newId,
  useState, useEffect, useLayoutEffect, useRef, useCallback });

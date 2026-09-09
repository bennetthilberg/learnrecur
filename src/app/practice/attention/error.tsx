"use client";

export default function NeedsAttentionError({ reset }: { reset: () => void }) {
  return (
    <main className="practiceShell practiceAttentionShell">
      <div className="practiceAttentionPage">
        <section className="practiceAttentionState practiceAttentionStateError" role="alert">
          <h1>Needs attention could not load</h1>
          <p>We could not read your recent review evidence. Your practice history is unchanged.</p>
          <button className="primaryButton" type="button" onClick={reset}>
            Try again
          </button>
        </section>
      </div>
    </main>
  );
}

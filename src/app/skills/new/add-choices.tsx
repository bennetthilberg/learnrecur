import { BookOpenText, Cards } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

// These choices are static and can be shown before navigation finishes.
export function AddChoices() {
  return (
    <>
      <header className="skillHeader createModeHeader" data-skeleton-reveal="skip">
        <div>
          <h1>What are you adding?</h1>
          <p>Materials provide source content. Skills are what you practice. Collections keep related skills together.</p>
        </div>
      </header>
      <div className="createModeChoices">
        <Link className="createModeChoice" href="/skills/new/one">
          <span className="createModeChoiceIcon"><Cards size={24} weight="bold" aria-hidden="true" /></span>
          <span>
            <strong>One skill</strong>
            <small>Paste notes, use images, or upload a short focused PDF.</small>
          </span>
          <span className="createModeChoiceCue" aria-hidden="true">Fast create</span>
        </Link>
        <Link className="createModeChoice" href="/skills/new/multiple">
          <span className="createModeChoiceIcon"><BookOpenText size={24} weight="bold" aria-hidden="true" /></span>
          <span>
            <strong>Multiple skills</strong>
            <small>Reuse a textbook, long PDF, or public book-like website.</small>
          </span>
          <span className="createModeChoiceCue" aria-hidden="true">Materials</span>
        </Link>
      </div>
    </>
  );
}

import Link from "next/link";

import { OpenWaterBackground, OpenWaterLogoMark } from "@/components/app/open-water";

export const metadata = {
  title: "Terms | LearnRecur",
  description: "Alpha participation terms draft for LearnRecur.",
};

export default function TermsPage() {
  return (
    <main className="entryShell">
      <OpenWaterBackground />
      <section className="entryPanel" aria-labelledby="terms-title">
        <Link className="entryBrand" href="/">
          <OpenWaterLogoMark />
          <span>LearnRecur</span>
        </Link>
        <article className="skillPanel policyArticle">
          <div className="skillPanelHeader">
            <div>
              <h1 id="terms-title">Terms</h1>
              <p>Alpha participation draft. Review before inviting external testers.</p>
            </div>
          </div>
          <div className="policyGrid" role="list" aria-label="Terms summary">
            <section>
              <h2>Alpha access</h2>
              <p>
                LearnRecur is an invite-only alpha. Access can be changed, paused,
                or removed while the product is being tested.
              </p>
            </section>
            <section>
              <h2>Use</h2>
              <p>
                Use the app for personal study practice. Do not upload material you
                do not have permission to use, and do not use the app for illegal,
                harmful, or abusive activity.
              </p>
            </section>
            <section>
              <h2>Exercises</h2>
              <p>
                Generated exercises are intended for study support. They can be wrong,
                incomplete, or mismatched to a source, so alpha users should flag issues
                and avoid relying on the app as the only source of truth.
              </p>
            </section>
            <section>
              <h2>Availability</h2>
              <p>
                The alpha may have downtime, data corrections, provider limits, or
                feature changes while production readiness is being hardened.
              </p>
            </section>
            <section>
              <h2>Data</h2>
              <p>
                Users can export study data from settings. Deletion and support requests
                are handled manually during alpha until the automated workflow is complete.
              </p>
            </section>
            <section>
              <h2>Contact</h2>
              <p>
                The production deployment must publish a support email before external
                testers are invited.
              </p>
            </section>
          </div>
          <p className="skillFormMessage policyNotice" data-tone="error" role="note">
            This is a product draft, not legal advice. Final copy needs founder and legal review.
          </p>
        </article>
      </section>
    </main>
  );
}

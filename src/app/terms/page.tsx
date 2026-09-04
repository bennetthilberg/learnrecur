import Link from "next/link";

import { OpenWaterBackground, OpenWaterLogoMark } from "@/components/app/open-water";
import { getSupportEmail } from "@/lib/support";

export const metadata = {
  title: "Terms | LearnRecur",
  description: "Participation terms for the LearnRecur closed alpha.",
};

export default function TermsPage() {
  const supportEmail = getSupportEmail();

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
              <p>Closed alpha participation terms. Updated September 3, 2026.</p>
            </div>
          </div>
          <menu className="policyGrid" aria-label="Terms summary">
            <li>
              <section>
                <h2>Account access</h2>
                <p>
                  LearnRecur is an invitation-only early product. Access may be changed, paused,
                  or removed while the closed alpha is being tested.
                </p>
              </section>
            </li>
            <li>
              <section>
                <h2>Use</h2>
                <p>
                  Use the app for personal study practice. Do not upload material you
                  do not have permission to use, and do not use the app for illegal,
                  harmful, or abusive activity.
                </p>
              </section>
            </li>
            <li>
              <section>
                <h2>Exercises</h2>
                <p>
                  Generated exercises are intended for study support. They can be wrong,
                  incomplete, or mismatched to a source, so testers should flag issues
                  and avoid relying on the app as the only source of truth.
                </p>
              </section>
            </li>
            <li>
              <section>
                <h2>Availability</h2>
                <p>
                  The app may have downtime, data corrections, provider limits, or
                  feature changes while production readiness is being hardened.
                </p>
              </section>
            </li>
            <li>
              <section>
                <h2>Data</h2>
                <p>
                  You can export saved study records from settings. Account deletion runs in the
                  background, disables access first, and may require retries before every provider
                  step is complete. Do not treat a queued request as immediate completion.
                </p>
              </section>
            </li>
            <li>
              <section>
                <h2>Contact</h2>
                <p>
                  {supportEmail ? (
                    <>Contact <a href={`mailto:${supportEmail}`}>{supportEmail}</a> for account or policy questions.</>
                  ) : (
                    <>Use the support address included with your alpha invitation for account or policy questions.</>
                  )}{" "}Learn how data is handled in the <Link href="/privacy">Privacy notice</Link>.
                </p>
              </section>
            </li>
          </menu>
        </article>
      </section>
    </main>
  );
}

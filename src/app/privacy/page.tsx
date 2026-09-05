import Link from "next/link";

import { OpenWaterBackground, OpenWaterLogoMark } from "@/components/app/open-water";
import { getSupportEmail } from "@/lib/support";

export const metadata = {
  title: "Privacy | LearnRecur",
  description: "How LearnRecur handles alpha learner data.",
};

export default function PrivacyPage() {
  const supportEmail = getSupportEmail();

  return (
    <main className="entryShell">
      <OpenWaterBackground />
      <section className="entryPanel" aria-labelledby="privacy-title">
        <Link className="entryBrand" href="/">
          <OpenWaterLogoMark />
          <span>LearnRecur</span>
        </Link>
        <article className="skillPanel policyArticle">
          <div className="skillPanelHeader">
            <div>
              <h1 id="privacy-title">Privacy</h1>
              <p>Closed alpha privacy notice. Updated September 3, 2026.</p>
            </div>
          </div>
          <div className="policyGrid">
            <section>
              <h2>Account data</h2>
              <p>
                LearnRecur stores the account identifier and profile details supplied through
                Clerk so study data stays attached to the correct signed-in learner. Production
                access is limited to verified email addresses on a server-side alpha allowlist.
              </p>
            </section>
            <section>
              <h2>Study data</h2>
              <p>
                The app stores collections, skills, exercises, attempts, review history,
                reminders, flags, generated drafts, and uploaded source metadata.
              </p>
            </section>
            <section>
              <h2>Source material</h2>
              <p>
                Uploaded images and PDFs are stored in private object storage. Extracted
                text and source references may be saved so generated skills and exercises can
                stay tied to the source. Do not upload material you are not permitted to use.
              </p>
            </section>
            <section>
              <h2>AI processing</h2>
              <p>
                Source material, skill definitions, and exercise candidates may be sent to the
                configured Google Gemini service to draft skills, generate exercises, and verify
                exercise quality. Meta Muse may receive the same task data only when configured as
                a fallback. Models do not receive account credentials or authority to change study
                data directly.
              </p>
            </section>
            <section>
              <h2>Service providers</h2>
              <p>
                LearnRecur uses service providers for hosting, authentication, database storage,
                private object storage, background jobs, model processing, optional agent access,
                and reminder email. Current integrations include Vercel, Clerk, Neon, Amazon S3,
                AWS Lambda, Amazon SQS, Amazon EventBridge, Google Gemini, optional Meta Muse and WorkOS, and Resend.
              </p>
            </section>
            <section>
              <h2>Export and deletion</h2>
              <p>
                Signed-in learners can export saved study records from settings before requesting
                deletion. Original uploaded file bytes are not included in that export. The
                background deletion workflow disables access first, removes inventoried private
                objects and relational account data, then removes the Clerk identity. A limited
                deletion tombstone remains so failed steps can resume safely.
              </p>
            </section>
            <section>
              <h2>Retention</h2>
              <p>
                Account and study data is retained while the account is active and as needed to
                operate the alpha. Deletion removes active account data through the workflow above;
                limited records may remain temporarily in provider backups or security and delivery
                logs under each provider’s retention practices. Alpha retention schedules may change
                as the service develops.
              </p>
            </section>
            <section>
              <h2>Contact</h2>
              <p>
                Questions about this notice or an account can be sent to{" "}
                {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : "the support address included with your alpha invitation"}.
                {" "}See also the <Link href="/terms">Terms</Link>.
              </p>
            </section>
          </div>
        </article>
      </section>
    </main>
  );
}

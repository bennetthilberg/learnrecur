import Link from "next/link";

import { OpenWaterBackground, OpenWaterLogoMark } from "@/components/app/open-water";

export const metadata = {
  title: "Privacy | LearnRecur",
  description: "How LearnRecur handles alpha learner data.",
};

export default function PrivacyPage() {
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
              <p>Alpha policy draft. Review before inviting external testers.</p>
            </div>
          </div>
          <div className="policyGrid">
            <section>
              <h2>Account data</h2>
              <p>
                LearnRecur stores the email, name, profile image, and sign-in identifier
                provided by Clerk so the app can connect study data to the signed-in learner.
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
                text may be saved so generated skills and exercises can stay tied to the source.
              </p>
            </section>
            <section>
              <h2>AI processing</h2>
              <p>
                Source material, skill definitions, and exercise candidates may be sent to
                configured AI providers to draft skills, extract text, generate exercises,
                and verify exercise quality.
              </p>
            </section>
            <section>
              <h2>Email</h2>
              <p>
                Reminder emails include due counts and a practice link. They should not include
                skill titles, source text, answers, or exercise content.
              </p>
            </section>
            <section>
              <h2>Controls</h2>
              <p>
                Signed-in learners can export study data from settings. During alpha, deletion
                requests are handled manually until the production deletion workflow is finalized.
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

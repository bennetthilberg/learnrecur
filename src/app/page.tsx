import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  OpenWaterBackground,
  OpenWaterHeroRings,
  OpenWaterHeroWaves,
  OpenWaterLogoMark,
} from "@/components/app/open-water";

export default async function Home() {
  const { userId } = await auth();

  if (userId) {
    redirect("/dashboard");
  }

  return (
    <main className="entryShell">
      <OpenWaterBackground />
      <section className="entryPanel" aria-labelledby="home-title">
        <Link className="entryBrand" href="/">
          <OpenWaterLogoMark />
          <span>LearnRecur</span>
        </Link>
        <div className="openWaterHero entryHero">
          <OpenWaterHeroWaves />
          <OpenWaterHeroRings />
          <div className="openWaterHeroContent">
            <h1 id="home-title" className="disp">
              Skill practice, scheduled by memory.
            </h1>
            <p>
              Upload a page, paste notes, or define a skill. Review the draft, then work
              through verified exercises whenever the schedule says it is time.
            </p>
            <div className="openWaterHeroActions">
              <Link className="bpbtn bpbtn-hero" href="/sign-up">
                Create account
              </Link>
              <Link className="bpbtn bpbtn-ghost" href="/sign-in">
                Sign in
              </Link>
            </div>
          </div>
        </div>
        <nav className="entryPolicyLinks" aria-label="Policies">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </section>
    </main>
  );
}

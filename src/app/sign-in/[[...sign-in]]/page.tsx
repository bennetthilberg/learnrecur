import { SignIn } from "@clerk/nextjs";

import { AuthShell } from "@/components/app/auth-shell";
import { clerkAppearance } from "@/components/app/clerk-appearance";

export default function SignInPage() {
  return (
    <AuthShell
      title="Sign in to LearnRecur."
      description="Return to your due skills, drafts, source material, and review history."
    >
      <SignIn
        appearance={clerkAppearance}
        fallbackRedirectUrl="/dashboard"
        forceRedirectUrl="/dashboard"
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-up"
      />
    </AuthShell>
  );
}

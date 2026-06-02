import { SignUp } from "@clerk/nextjs";

import { AuthShell } from "@/components/app/auth-shell";
import { clerkAppearance } from "@/components/app/clerk-appearance";

export default function SignUpPage() {
  return (
    <AuthShell
      title="Create a LearnRecur account."
      description="This temporary sign-up screen exists so we can verify Clerk and database ownership."
    >
      <SignUp
        appearance={clerkAppearance}
        fallbackRedirectUrl="/dashboard"
        forceRedirectUrl="/dashboard"
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
      />
    </AuthShell>
  );
}

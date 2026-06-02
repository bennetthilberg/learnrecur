import { SignIn } from "@clerk/nextjs";

import { AuthShell } from "@/components/app/auth-shell";
import { clerkAppearance } from "@/components/app/clerk-appearance";

export default function SignInPage() {
  return (
    <AuthShell
      title="Sign in to LearnRecur."
      description="Use your development Clerk account to test the protected app spine."
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

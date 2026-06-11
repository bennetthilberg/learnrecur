import { SignUp } from "@clerk/nextjs";

import { AuthShell } from "@/components/app/auth-shell";
import { clerkAppearance } from "@/components/app/clerk-appearance";

export default function SignUpPage() {
  return (
    <AuthShell
      title="Create a LearnRecur account"
      description="Start a private study space for source-backed skills, verified practice, and due reminders."
    >
      <SignUp
        appearance={clerkAppearance}
        forceRedirectUrl="/dashboard"
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
      />
    </AuthShell>
  );
}

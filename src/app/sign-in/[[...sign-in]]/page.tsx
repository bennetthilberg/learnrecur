import { SignIn } from "@clerk/nextjs";

import { AuthShell } from "@/components/app/auth-shell";
import { clerkAppearance } from "@/components/app/clerk-appearance";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const { redirect_url: requestedRedirect } = await searchParams;
  const redirectUrl =
    requestedRedirect === "/oauth/workos/complete" ? requestedRedirect : "/dashboard";

  return (
    <AuthShell
      title="Sign in to LearnRecur"
      description="Return to your due skills, drafts, source material, and review history."
    >
      <SignIn
        appearance={clerkAppearance}
        forceRedirectUrl={redirectUrl}
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-up"
      />
    </AuthShell>
  );
}

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import {
  getAlphaAccessPolicy,
  isAlphaUserAllowed,
} from "@/lib/alpha-access";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/history(.*)",
  "/ops(.*)",
  "/practice(.*)",
  "/collections(.*)",
  "/settings(.*)",
  "/skills(.*)",
  "/oauth/workos/complete(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  const alphaPolicy = getAlphaAccessPolicy();

  if (isProtectedRoute(request)) {
    const { userId } = await auth.protect();

    if (!(await isAlphaUserAllowed(userId, alphaPolicy))) {
      return new NextResponse("This LearnRecur alpha is invitation-only.", {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
  }

  const response = NextResponse.next();

  if (process.env.NODE_ENV === "production") {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  return response;
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};

import { serve } from "inngest/next";

import { inngest } from "@/lib/inngest/client";
import { learnRecurInngestFunctions } from "@/lib/inngest/functions";

export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: learnRecurInngestFunctions,
});

import { guardMutation, ok, readJson, route } from "@/lib/server/http";
import { currentCustomer, endAllCustomerSessions, endCustomerSession } from "@/lib/server/customers";
import { z } from "@/lib/zod";

export const dynamic = "force-dynamic";

const schema = z.object({ everywhere: z.boolean().optional() });

/** POST { everywhere? } → signs out this device, or every device. */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const { everywhere } = await readJson(req, schema);
  const me = everywhere ? await currentCustomer() : null;
  if (me) await endAllCustomerSessions(me.id);
  else await endCustomerSession();
  return ok({ signedOut: true });
});

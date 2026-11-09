import { guardMutation, ok, readJson, route } from "@/lib/server/http";
import { deleteAccount, requireCustomer } from "@/lib/server/customers";
import { z } from "@/lib/zod";

export const dynamic = "force-dynamic";

const schema = z.object({ confirm: z.literal("DELETE", { error: "Type DELETE to confirm" }) });

/** POST { confirm: "DELETE" } → the account is deleted and signed out. Orders are kept, unlinked. */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const me = await requireCustomer();
  await readJson(req, schema);
  await deleteAccount(me.id);
  return ok({ deleted: true });
});

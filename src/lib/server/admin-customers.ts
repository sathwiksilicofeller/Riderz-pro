import "server-only";

import { z } from "@/lib/zod";
import { sql, sqlOne, transaction } from "@/lib/db/client";
import type { TicketTopic } from "@/lib/account/schemas";
import { ApiError } from "./http";
import { audit } from "./vendors";

/**
 * Admin side of the customer help desk (messages from /contact and /account/help). Replies show
 * on the customer's /account/help when they have an account; the inbox also offers WhatsApp and a
 * phone link, since a guest only sees a reply that way.
 */

export type CustomerTicketItem = {
  id: string;
  hasAccount: boolean;
  name: string;
  mobile: string;
  email: string | null;
  orderNumber: string | null;
  topic: TicketTopic;
  body: string;
  status: "open" | "answered" | "closed";
  adminReply: string | null;
  repliedBy: string | null;
  repliedAt: string | null;
  createdAt: string;
};

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export async function listCustomerTicketsAdmin(
  filter: "open" | "answered" | "closed" | "all",
): Promise<{ items: CustomerTicketItem[]; counts: Record<string, number> }> {
  const rows = await sql<{
    id: string;
    customer_id: string | null;
    name: string;
    mobile: string;
    email: string | null;
    order_number: string | null;
    topic: TicketTopic;
    body: string;
    status: CustomerTicketItem["status"];
    admin_reply: string | null;
    replied_by: string | null;
    replied_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, customer_id, name, mobile, email, order_number, topic, body, status, admin_reply, replied_by, replied_at, created_at
       FROM customer_tickets WHERE ($1 = 'all' OR status = $1)
      ORDER BY (status = 'open') DESC, created_at ASC LIMIT 200`,
    [filter],
  );
  const c = await sql<{ status: string; n: string }>("SELECT status, count(*) AS n FROM customer_tickets GROUP BY status");
  const counts: Record<string, number> = { open: 0, answered: 0, closed: 0 };
  for (const r of c) counts[r.status] = Number(r.n);
  return {
    counts,
    items: rows.map((r) => ({
      id: r.id,
      hasAccount: r.customer_id !== null,
      name: r.name,
      mobile: r.mobile,
      email: r.email,
      orderNumber: r.order_number,
      topic: r.topic,
      body: r.body,
      status: r.status,
      adminReply: r.admin_reply,
      repliedBy: r.replied_by,
      repliedAt: iso(r.replied_at),
      createdAt: iso(r.created_at)!,
    })),
  };
}

export async function openCustomerTickets(): Promise<number | null> {
  try {
    const r = await sqlOne<{ n: string }>("SELECT count(*) AS n FROM customer_tickets WHERE status = 'open'");
    return Number(r?.n ?? 0);
  } catch {
    return null;
  }
}

export const customerTicketActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), reply: z.string().trim().min(2, "Write a reply").max(3000) }),
  z.object({ action: z.literal("close") }),
]);

export async function actOnCustomerTicket(id: string, input: z.infer<typeof customerTicketActionSchema>, actor: string, ip: string) {
  const by = { type: "admin" as const, id: actor };
  await transaction(async (q) => {
    const rows =
      input.action === "reply"
        ? await q(
            `UPDATE customer_tickets SET admin_reply = $2, replied_by = $3, replied_at = now(), status = 'answered'
              WHERE id = $1 AND status IN ('open','answered') RETURNING id`,
            [id, input.reply, actor],
          )
        : await q("UPDATE customer_tickets SET status = 'closed' WHERE id = $1 AND status <> 'closed' RETURNING id", [id]);
    if (rows.length === 0) {
      const exists = (await q("SELECT 1 FROM customer_tickets WHERE id = $1", [id]))[0];
      if (!exists) throw new ApiError(404, "not_found", "Message not found.");
      throw new ApiError(409, "stale", "This message was closed in the meantime. The list has been refreshed.");
    }
    await audit(by, input.action === "reply" ? "customer_support.reply" : "customer_support.close", { ip, detail: { ticketId: id } }, q);
  });
}

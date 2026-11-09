/**
 * Admin team roles and what each may open. Client-safe (the team page and the hub use it too); the
 * server checks happen in src/lib/server/admin-auth.ts.
 *
 *   owner       everything, including the team and the audit log
 *   manager     everything except the team
 *   operations  orders, dispatch, riders, customers, customer and seller messages
 *   catalog     sellers (KYC, products, changes), the catalogue tools, coupons; orders to look at
 *   finance     payouts, refunds, sellers' bank details, reports, the audit log; orders to look at
 *   support     customers, customer and seller messages; orders to look at
 */
import { z } from "@/lib/zod";

export const ADMIN_ROLES = ["owner", "manager", "operations", "catalog", "finance", "support"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMS = [
  "team",
  "audit",
  "orders",
  "orders.view",
  "refunds",
  "dispatch",
  "riders",
  "support",
  "sellers",
  "sellers.reveal",
  "payouts",
  "catalog",
  "coupons",
  "customers",
  "reports",
] as const;
export type AdminPerm = (typeof ADMIN_PERMS)[number];

const ROLE_PERMS: Record<AdminRole, readonly AdminPerm[]> = {
  owner: ADMIN_PERMS,
  manager: ADMIN_PERMS.filter((p) => p !== "team"),
  operations: ["orders", "orders.view", "dispatch", "riders", "support", "customers"],
  catalog: ["sellers", "catalog", "coupons", "orders.view"],
  finance: ["payouts", "refunds", "sellers.reveal", "audit", "orders.view", "reports"],
  support: ["support", "orders.view", "customers"],
};

export const ROLE_LABELS: Record<AdminRole, string> = {
  owner: "Owner",
  manager: "Manager",
  operations: "Operations",
  catalog: "Catalogue",
  finance: "Finance",
  support: "Support",
};

export const ROLE_TEXT: Record<AdminRole, string> = {
  owner: "Everything, including the team and the audit log.",
  manager: "Everything except managing the team.",
  operations: "Orders, dispatch, riders, customers, customer and seller messages.",
  catalog: "Seller KYC, products and changes, catalogue tools, coupons. Can look at orders.",
  finance: "Payouts, refunds, sellers' bank details, reports, audit log. Can look at orders.",
  support: "Customers, customer and seller messages. Can look at orders.",
};

export const can = (role: AdminRole, perm: AdminPerm) => ROLE_PERMS[role].includes(perm);

/** What the signed-in team member's browser may know about them. */
export type AdminSelf = { id: string; email: string; name: string; role: AdminRole; source: "team" | "env" | "dev" };

export type TeamMember = {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: "active" | "disabled";
  source: "team" | "env";
  createdAt: string;
  lastSignInAt: string | null;
  sessions: number;
};

export type TeamInvite = { id: string; kind: "invite" | "reset"; email: string; name: string; role: AdminRole; createdBy: string; expiresAt: string };

export const PASSWORD_MIN = 12;

const email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address");
const name = z.string().trim().min(2, "Name is required").max(80, "Name must be 80 characters or fewer");
const password = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
  .max(200, "That password is too long");

export const adminSignInSchema = z.object({ email: z.string().trim().toLowerCase().min(1, "Enter your email").max(254), password: z.string().min(1, "Enter your password").max(200) });
export const inviteSchema = z.object({ email, name, role: z.enum(ADMIN_ROLES) });
export const acceptInviteSchema = z
  .object({ token: z.string().min(20).max(100), name, password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "The passwords don't match", path: ["confirm"] });
export const memberActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("role"), role: z.enum(ADMIN_ROLES) }),
  z.object({ action: z.literal("disable") }),
  z.object({ action: z.literal("enable") }),
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("sign_out") }),
]);

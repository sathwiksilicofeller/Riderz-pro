/**
 * Rider portal shapes, rules and labels shared by the rider pages, the admin screens and the API.
 * Client-safe.
 */
import { z } from "@/lib/zod";
import { mobileSchema } from "@/lib/vendor/validators";

/* ------------------------------------------------------------ service area */

/** Where Riderzpro's own riders deliver. Orders elsewhere go by courier as before. */
export const SERVICE_CITIES = ["Delhi", "Gurugram", "Noida", "Greater Noida", "Ghaziabad", "Faridabad"] as const;
export type ServiceCity = (typeof SERVICE_CITIES)[number];
export const SERVICE_AREA_LABEL = "Delhi NCR";

const CITY_ALIASES: Record<string, ServiceCity> = {
  delhi: "Delhi",
  "new delhi": "Delhi",
  "delhi ncr": "Delhi",
  gurugram: "Gurugram",
  gurgaon: "Gurugram",
  noida: "Noida",
  "greater noida": "Greater Noida",
  ghaziabad: "Ghaziabad",
  faridabad: "Faridabad",
};

/** The service city an address is in, or null when it is outside the rider area. */
export function serviceCity(city: string): ServiceCity | null {
  const key = city.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  return CITY_ALIASES[key] ?? null;
}

/* ----------------------------------------------------------------- riders */

export const VEHICLES = [
  { value: "motorcycle", label: "Motorcycle" },
  { value: "scooter", label: "Scooter (petrol)" },
  { value: "ev_scooter", label: "Electric scooter" },
  { value: "bicycle", label: "Bicycle" },
] as const;
export type VehicleType = (typeof VEHICLES)[number]["value"];
export const vehicleLabel = (v: VehicleType) => VEHICLES.find((x) => x.value === v)?.label ?? v;

/** Vehicles that need a driving licence, registration and insurance. */
export const needsLicence = (v: VehicleType) => v === "motorcycle" || v === "scooter";

export type RiderStatus = "applied" | "approved" | "changes_requested" | "rejected" | "suspended";
export const RIDER_STATUS_LABELS: Record<RiderStatus, string> = {
  applied: "Under review",
  approved: "Approved",
  changes_requested: "Changes needed",
  rejected: "Not approved",
  suspended: "Suspended",
};

/** Bump when the application's declarations change; riders accept the new version on resubmission. */
export const RIDER_CONSENT_VERSION = "2026-10-17";

/** "DL 3C AB 1234" → "DL3CAB1234"; also Bharat series "22 BH 1234 AA". */
export const normaliseVehicleNumber = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
const VEHICLE_RE = /^([A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$/;

export const applySchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").min(3, "Enter your full name").max(80),
    city: z.enum(SERVICE_CITIES, { error: "Pick the city you'll ride in" }),
    vehicleType: z.enum(["motorcycle", "scooter", "ev_scooter", "bicycle"], { error: "Pick your vehicle" }),
    vehicleNumber: z
      .string()
      .max(20)
      .optional()
      .transform((v) => (v ? normaliseVehicleNumber(v) : null)),
    confirmAccurate: z.literal(true, { error: "Please confirm" }),
    confirmLicence: z.boolean(),
    confirmPrivacy: z.literal(true, { error: "Please confirm" }),
  })
  .superRefine((v, ctx) => {
    if (needsLicence(v.vehicleType)) {
      if (!v.vehicleNumber) ctx.addIssue({ path: ["vehicleNumber"], code: "custom", message: "Enter the registration number" });
      if (!v.confirmLicence) ctx.addIssue({ path: ["confirmLicence"], code: "custom", message: "Needed for motor vehicles" });
    }
    if (v.vehicleNumber && !VEHICLE_RE.test(v.vehicleNumber)) {
      ctx.addIssue({ path: ["vehicleNumber"], code: "custom", message: "Enter it as on the RC, e.g. DL 3C AB 1234" });
    }
  });
export type ApplyInput = z.output<typeof applySchema>;

export const riderCodeSendSchema = z.object({ mobile: mobileSchema });
export const riderCodeVerifySchema = z.object({ mobile: mobileSchema, code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });

/* ------------------------------------------------------------------- jobs */

export type JobStatus = "offered" | "accepted" | "picked_up" | "delivered" | "declined" | "cancelled";
export const JOB_LABELS: Record<JobStatus, string> = {
  offered: "Offered",
  accepted: "Accepted",
  picked_up: "Picked up",
  delivered: "Delivered",
  declined: "Declined",
  cancelled: "Cancelled",
};
/** Jobs still in the rider's hands. */
export const LIVE_JOB: JobStatus[] = ["offered", "accepted", "picked_up"];

/** Suggested pay per delivery (integer rupees); the admin can change it per job. */
export const RIDER_DEFAULT_PAY = 60;
export const RIDER_PAY_MAX = 2000;

export const deliveryCodeSchema = z.object({ code: z.string().trim().regex(/^\d{4}$/, "Enter the customer's 4-digit code") });

/** What the rider sees of a job. The customer's phone and full address only once accepted. */
export type RiderJobView = {
  id: string;
  status: JobStatus;
  orderNumber: string;
  pickupName: string;
  pickupAddress: string;
  pickupPhone: string | null;
  dropName: string;
  dropArea: string;
  dropAddress: string | null;
  dropPhone: string | null;
  city: string;
  earning: number;
  items: { title: string; qty: number }[];
  note: string | null;
  offeredAt: string;
  acceptedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  codeLocked: boolean;
};

export type RiderSelf = {
  id: string;
  mobile: string;
  name: string;
  city: string;
  vehicleType: VehicleType;
  vehicleNumber: string | null;
  status: RiderStatus;
  reviewNote: string | null;
  online: boolean;
  /** Agreed to share their location while delivering (live tracking). */
  locationConsent: boolean;
};

export type RiderEarnings = { unpaid: number; unpaidJobs: number; paid: number; today: number; payouts: { id: string; amount: number; jobs: number; reference: string; createdAt: string }[] };

import { z } from "zod";

/**
 * The app's zod entry point: import `z` from here, not from "zod".
 *
 * zod 4 reworded every default message ("Required" became "Invalid input: expected string, received
 * undefined"). Forms and API `fields` show these messages wherever a schema has no message of its own, so
 * this error map keeps zod 3's wording. Messages set on a schema still win over it.
 */

type Issue = z.core.$ZodRawIssue;

/** zod 3's name for the type of a value ("nan", "null", "array"...). */
function typeName(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "nan" : "number";
  if (typeof value !== "object") return typeof value;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  if (value instanceof Promise) return "promise";
  return "object";
}

const quoted = (values: readonly unknown[]) => values.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(" | ");

function v3Message(issue: Issue): string | undefined {
  switch (issue.code) {
    case "invalid_type": {
      if (issue.input === undefined) return "Required";
      if (issue.expected === "int") return "Expected integer, received float";
      // zod 4 refuses Infinity up front; zod 3 let it through to .int() / .finite()
      if (issue.expected === "number" && typeof issue.input === "number" && !Number.isNaN(issue.input)) {
        return hasIntCheck(issue.inst) ? "Expected integer, received float" : "Number must be finite";
      }
      return `Expected ${issue.expected}, received ${typeName(issue.input)}`;
    }
    case "invalid_value": {
      const type = (issue.inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;
      if (type === "literal") return `Invalid literal value, expected ${JSON.stringify(issue.values[0])}`;
      if (issue.input === undefined) return "Required";
      if (typeof issue.input !== "string") return `Expected ${quoted(issue.values)}, received ${typeName(issue.input)}`;
      return `Invalid enum value. Expected ${quoted(issue.values)}, received '${String(issue.input)}'`;
    }
    case "too_small": {
      const n = String(issue.minimum);
      if (issue.origin === "string") return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? "at least" : "over"} ${n} character(s)`;
      if (issue.origin === "array" || issue.origin === "set") return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? "at least" : "more than"} ${n} element(s)`;
      if (issue.origin === "date") return `Date must be ${issue.exact ? "exactly equal to " : issue.inclusive ? "greater than or equal to " : "greater than "}${new Date(Number(issue.minimum))}`;
      return `Number must be ${issue.exact ? "exactly equal to " : issue.inclusive ? "greater than or equal to " : "greater than "}${n}`;
    }
    case "too_big": {
      const n = String(issue.maximum);
      if (issue.origin === "string") return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? "at most" : "under"} ${n} character(s)`;
      if (issue.origin === "array" || issue.origin === "set") return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? "at most" : "less than"} ${n} element(s)`;
      if (issue.origin === "date") return `Date must be ${issue.exact ? "exactly" : issue.inclusive ? "smaller than or equal to" : "smaller than"} ${new Date(Number(issue.maximum))}`;
      return `${issue.origin === "bigint" ? "BigInt" : "Number"} must be ${issue.exact ? "exactly" : issue.inclusive ? "less than or equal to" : "less than"} ${n}`;
    }
    case "invalid_format": {
      if (issue.format === "regex") return "Invalid";
      if (issue.format === "starts_with") return `Invalid input: must start with "${(issue as { prefix?: string }).prefix}"`;
      if (issue.format === "ends_with") return `Invalid input: must end with "${(issue as { suffix?: string }).suffix}"`;
      if (issue.format === "includes") return `Invalid input: must include "${(issue as { includes?: string }).includes}"`;
      return `Invalid ${issue.format}`;
    }
    case "not_multiple_of":
      return `Number must be a multiple of ${String(issue.divisor)}`;
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${issue.keys.map((k) => `'${k}'`).join(", ")}`;
    case "invalid_union":
      if (issue.discriminator !== undefined) return "Invalid discriminator value. Expected " + quoted(discriminatorValues(issue));
      return "Invalid input";
    case "custom":
      return "Invalid input";
    default:
      return undefined;
  }
}

/** Whether a z.number() schema has .int(). */
function hasIntCheck(inst: unknown): boolean {
  const checks = (inst as { _zod?: { def?: { checks?: { _zod: { def: { check?: string; format?: string } } }[] } } } | undefined)?._zod?.def?.checks ?? [];
  return checks.some((c) => c._zod.def.check === "number_format" && c._zod.def.format?.includes("int"));
}

/** The allowed discriminator values of a z.discriminatedUnion, read from the failing schema. */
function discriminatorValues(issue: Issue): unknown[] {
  if (issue.code !== "invalid_union" || !issue.discriminator) return [];
  const options = (issue.inst as { _zod?: { def?: { options?: { _zod: { propValues?: Record<string, Set<unknown>> } }[] } } } | undefined)?._zod?.def?.options ?? [];
  return options.flatMap((o) => [...(o._zod.propValues?.[issue.discriminator!] ?? [])]);
}

z.config({ customError: v3Message });

export { z };

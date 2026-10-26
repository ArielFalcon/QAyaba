/* The one place a request body is read and parsed. */

import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { readBody } from "../helpers";
import { ApiError } from "./api-error";

export interface ParseBodyOptions {
  /* A blank body is accepted and parses as `{}`. */
  readonly optional?: boolean;
  /* Builds the failure for a body the schema rejects; the default joins the issue messages. */
  readonly invalid?: (error: z.ZodError) => ApiError;
  /* The failures this function throws carry no `schemaVersion`. */
  readonly bare?: true;
}

/* A body the schema rejects with this label answers the label and the schema's issues. */
export function withIssues(label: string): (error: z.ZodError) => ApiError {
  return (error) => new ApiError(400, label, { bare: true, extra: { issues: error.issues } });
}

/* Reads the body (at most 100,000 bytes) and parses it through `schema`. Text that is not JSON, a body over the cap and a body the schema rejects all answer 400. */
export async function parseJsonBody<S extends z.ZodTypeAny>(req: IncomingMessage, schema: S, options: ParseBodyOptions = {}): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await readBody(req);
    raw = options.optional && !text.trim() ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid JSON", options.bare ? { bare: true } : {});
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw (options.invalid ?? ((error) => new ApiError(400, error.issues.map((i) => i.message).join("; "), options.bare ? { bare: true } : {})))(parsed.error);
}

/* The fields a route reads from a body that may be any JSON value: anything but an object has no fields. */
export function fieldsOf(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/* Any JSON value, read as the object whose fields the route looks for. */
export const JsonFieldsSchema = z.unknown().transform(fieldsOf);

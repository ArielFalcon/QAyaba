import { z } from "zod";

export const LOGIN_PATH_MAX_LENGTH = 200;

/*
 * A path on the app's own origin: one leading slash, then no whitespace. A second leading slash
 * (`//host`) is refused because a browser reads it as another origin, and an absolute URL never
 * starts with a slash at all. The credentials the login submits must never be steerable off-origin.
 */
export const LOGIN_PATH_PATTERN = /^\/(?!\/)\S*$/;

export const LoginPathSchema = z.string().max(LOGIN_PATH_MAX_LENGTH).regex(LOGIN_PATH_PATTERN);

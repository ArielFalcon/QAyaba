import { z } from "zod";

export const LOGIN_PATH_MAX_LENGTH = 200;

/*
 * A path on the app's own origin: one leading slash, then no whitespace, backslash or control
 * character. A second leading slash (`//host`) is refused because a browser reads it as another
 * origin, and so is a leading backslash: URL parsing reads `\` as `/`, so `/\host` and `/\/host`
 * name another origin too, and a backslash anywhere else is refused as not one plain path. An
 * absolute URL never starts with a slash at all. The credentials the login submits must never be
 * steerable off-origin.
 */
export const LOGIN_PATH_PATTERN = /^\/(?![\/\\])[^\s\\\x00-\x1f\x7f]*$/;

export const LoginPathSchema = z.string().max(LOGIN_PATH_MAX_LENGTH).regex(LOGIN_PATH_PATTERN);

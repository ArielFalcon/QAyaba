/*
 * Edits the config text an operator already has, in place, instead of rebuilding it from a loaded
 * config. A loaded config is env-EXPANDED and holds only what the schema knows, so a rebuild loses
 * comments, `${VAR}` placeholders (an expanded URL takes their place), keys the schema strips and
 * every field the rebuild does not carry. A patch touches only the managed fields the caller
 * supplies: repo, baseBranch, dev.baseUrl, dev.versionUrl, code, qa.needsReview, qa.shadow,
 * qa.testDataPrefix, services and auth. Everything else, and every managed field the caller left
 * out, comes out as it went in. A patch that changes nothing returns the text untouched.
 *
 * A supplied value that equals what the placeholder already written there expands to (under the
 * environments the caller names) is the value on disk, not a change: a client that pre-filled a form
 * from the expanded config resends every field, and writing those back would replace each `${VAR}`
 * with its expansion, a credential-bearing URL included. Comparing reads the file; nothing is ever
 * written from the expanded form.
 *
 * A block that is missing is created; one that is empty (a bare `qa:`, or a `dev:` whose children
 * are all commented out) becomes a mapping, keeping its comments. An alias where the patch needs to
 * read or write is refused, since editing it would edit every place that shares it.
 *
 * The YAML writer keeps comment text, key order, quote styles and blank lines, but it normalizes
 * indentation and the gap before an inline comment on the lines it re-emits. Written strings are
 * double-quoted, except the login kind, which stays a bare keyword as `buildYaml` writes it.
 */

import { Scalar, YAMLMap, YAMLSeq, isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { expandEnv } from "../../orchestrator/config-loader";
import type { TestTarget } from "../../types";
import type { OnboardAuthInput, OnboardServiceInput } from "../onboard";

export interface AppYamlPatch {
  repo?: string;
  baseBranch?: string;
  baseUrl?: string;
  /** An empty string removes the key. */
  versionUrl?: string;
  /** Applies the rules `buildYaml` applies for that target: a code app has no DEV version url, login or services. */
  target?: TestTarget;
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
  /** The desired list: services not named are removed; a service kept keeps every key the patch does not manage, and a field left out of a kept service keeps its value. */
  services?: readonly OnboardServiceInput[];
  /** Supplied keys overwrite, absent and unknown keys are kept, and a kind change drops the other kind's keys. */
  auth?: OnboardAuthInput;
  /** Removes the auth block; wins over `auth`. */
  clearAuth?: boolean;
}

export interface AppYamlPatchOptions {
  /** Environments a `${VAR}` placeholder in the file may be read under; a supplied value equal to its expansion under any of them is not a change. */
  expandWith?: readonly Record<string, string | undefined>[];
}

/* The auth keys only one kind uses. */
const AUTH_KEYS_BY_KIND: Record<OnboardAuthInput["kind"], readonly (keyof OnboardAuthInput)[]> = {
  form: ["usernameEnv", "passwordEnv", "loginPath"],
  mtls: ["certEnv", "certPassEnv"],
};
const AUTH_FIELDS: readonly (keyof OnboardAuthInput)[] = ["usernameEnv", "passwordEnv", "certEnv", "certPassEnv"];
const SERVICE_FIELDS = ["openapi", "versionUrl"] as const;

/* Both a Document and a YAMLMap read and write by path. */
interface PathHolder {
  getIn(path: Iterable<unknown>, keepScalar?: boolean): unknown;
  setIn(path: Iterable<unknown>, value: unknown): void;
}

export function patchAppYaml(rawYaml: string, patch: AppYamlPatch, options: AppYamlPatchOptions = {}): string {
  const doc = parseDocument(rawYaml);
  const parseError = doc.errors[0];
  if (parseError) throw new Error(`the config is not valid YAML: ${parseError.message}`);
  if (!isMap(doc.contents)) throw new Error("the config is not a YAML mapping");

  let changed = false;
  const environments = options.expandWith ?? [];

  /* What is written already means `value`: it is that value, or a placeholder that expands to it. */
  const alreadyReads = (written: unknown, value: string | boolean): boolean => {
    if (written === value) return true;
    if (typeof written !== "string") return false;
    return environments.some((env) => {
      try {
        return expandEnv(written, env) === String(value);
      } catch {
        /* A placeholder whose variable is unset under this environment does not read as anything. */
        return false;
      }
    });
  };

  /* Every path written or deleted here is a top-level key or one key below one, so a path has at most one block above its key. */
  const containerOf = (path: string[]): string | undefined => (path.length > 1 ? path[0] : undefined);

  /*
   * Checks the block a write or a delete goes through. The library throws on an alias there, and on an
   * empty or scalar one it cannot write into, so an alias is refused with its key and, when writing, a
   * block that is not a mapping (a bare `qa:`, or a `dev:` whose children are all commented out)
   * becomes an empty one that keeps the comments it carried.
   */
  const guardContainer = (holder: PathHolder, container: string | undefined, open: boolean): void => {
    if (container === undefined) return;
    const node = holder.getIn([container], true);
    if (isAlias(node)) throw new Error(`unsupported: alias at ${container}`);
    if (!open || isMap(node)) return;
    const map = new YAMLMap(doc.schema);
    if (isScalar(node)) {
      map.comment = node.comment;
      map.commentBefore = node.commentBefore;
    }
    holder.setIn([container], map);
  };

  const setScalar = (holder: PathHolder, path: string[], value: string | boolean, style: Scalar.Type): void => {
    const found = holder.getIn(path, true);
    /* An alias reads as the value it points at, but a write replaces the alias itself. */
    const current = isAlias(found) ? found.resolve(doc) : found;
    if (isScalar(current) && alreadyReads(current.value, value)) return;
    guardContainer(holder, containerOf(path), true);
    if (isScalar(found)) {
      found.value = value;
      found.type = style;
    } else {
      const node = doc.createNode(value);
      node.type = style;
      holder.setIn(path, node);
    }
    changed = true;
  };
  const setString = (path: string[], value: string, holder: PathHolder = doc, style: Scalar.Type = Scalar.QUOTE_DOUBLE): void =>
    setScalar(holder, path, value, style);
  const setBoolean = (path: string[], value: boolean): void => setScalar(doc, path, value, Scalar.PLAIN);
  const remove = (path: string[]): void => {
    guardContainer(doc, containerOf(path), false);
    if (!doc.hasIn(path)) return;
    doc.deleteIn(path);
    changed = true;
  };
  /* A block added at the top level is set apart from the one above it. */
  const setApart = (key: string): void => {
    const root: unknown = doc.contents;
    if (!isMap(root)) return;
    const pair = root.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
    if (!pair) return;
    const keyNode = isScalar(pair.key) ? pair.key : doc.createNode(key);
    keyNode.spaceBefore = true;
    pair.key = keyNode;
  };

  const isCode = (): boolean => alreadyReads(doc.get("code"), true);
  const target: TestTarget = patch.target ?? (isCode() ? "code" : "e2e");

  if (patch.target === "code") {
    setBoolean(["code"], true);
    remove(["dev", "versionUrl"]);
    remove(["auth"]);
    remove(["services"]);
  } else if (patch.target === "e2e" && isCode()) {
    remove(["code"]);
  }

  if (patch.repo !== undefined) setString(["repo"], patch.repo);
  if (patch.baseBranch !== undefined) setString(["baseBranch"], patch.baseBranch);
  if (patch.baseUrl !== undefined) setString(["dev", "baseUrl"], patch.baseUrl);
  if (patch.versionUrl !== undefined && target !== "code") {
    if (patch.versionUrl === "") remove(["dev", "versionUrl"]);
    else setString(["dev", "versionUrl"], patch.versionUrl);
  }
  if (patch.needsReview !== undefined) setBoolean(["qa", "needsReview"], patch.needsReview);
  if (patch.shadow !== undefined) setBoolean(["qa", "shadow"], patch.shadow);
  if (patch.testDataPrefix !== undefined) setString(["qa", "testDataPrefix"], patch.testDataPrefix);

  if (target !== "code") {
    if (patch.clearAuth) remove(["auth"]);
    else if (patch.auth) patchAuth(patch.auth);
    if (patch.services) patchServices(patch.services);
  }

  return changed ? doc.toString({ lineWidth: 0 }) : rawYaml;

  function patchAuth(auth: OnboardAuthInput): void {
    const hadAuth = doc.hasIn(["auth"]);
    const currentKind = doc.getIn(["auth", "kind"]);
    if (currentKind !== undefined && currentKind !== auth.kind) {
      const other = auth.kind === "form" ? "mtls" : "form";
      for (const key of AUTH_KEYS_BY_KIND[other]) remove(["auth", key]);
    }
    setString(["auth", "kind"], auth.kind, doc, Scalar.PLAIN);
    for (const field of AUTH_FIELDS) {
      const value = auth[field];
      if (typeof value === "string" && value !== "") setString(["auth", field], value);
    }
    /* Written even when empty, so validation refuses an empty path instead of the patch ignoring it. */
    if (typeof auth.loginPath === "string") setString(["auth", "loginPath"], auth.loginPath);
    if (!hadAuth) setApart("auth");
  }

  /*
   * The supplied list is the list: a service it does not name is removed, one it names in another
   * position is moved, and one it adds is created. A service that stays keeps every key of its own,
   * so a field the supplied entry leaves out (`openapi` or `versionUrl` omitted) keeps the value on
   * disk, and only an empty string removes one.
   */
  function patchServices(services: readonly OnboardServiceInput[]): void {
    if (services.length === 0) {
      remove(["services"]);
      return;
    }
    guardContainer(doc, "services", false);
    const current = doc.getIn(["services"]);
    const aliasAt = isSeq(current) ? current.items.findIndex(isAlias) : -1;
    if (aliasAt >= 0) throw new Error(`unsupported: alias at services.${aliasAt}`);
    const entries = isSeq(current) ? current.items.filter(isMap) : [];
    const byRepo = new Map(entries.map((entry) => [entry.get("repo"), entry]));
    const sameList = isSeq(current) && entries.length === current.items.length && entries.length === services.length
      && services.every((service, i) => entries[i]?.get("repo") === service.repo);

    const merged = services.map((service): YAMLMap => {
      const entry = byRepo.get(service.repo) ?? new YAMLMap(doc.schema);
      setString(["repo"], service.repo, entry);
      for (const field of SERVICE_FIELDS) {
        const value = service[field];
        if (value === undefined) continue;
        if (value === "") {
          if (entry.delete(field)) changed = true;
        } else {
          setString([field], value, entry);
        }
      }
      return entry;
    });
    if (sameList) return;

    const seq = new YAMLSeq(doc.schema);
    seq.items = merged;
    const hadServices = doc.hasIn(["services"]);
    doc.setIn(["services"], seq);
    changed = true;
    if (!hadServices) setApart("services");
  }
}

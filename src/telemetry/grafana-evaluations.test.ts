/* The provisioned evaluation dashboard and its provider, parsed from the real files and the compose mount, so an edit that
   breaks provisioning or puts an unbounded label in a query fails here (docs/telemetry-local.md). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

type Service = { volumes?: string[] };
type Compose = { services: Record<string, Service> };
type Target = { expr?: string; datasource?: { type?: string; uid?: string } };
type Panel = { title?: string; datasource?: { type?: string; uid?: string }; targets?: Target[] };
type Dashboard = { uid?: string; title?: string; panels?: Panel[] };
type Provider = { providers?: Array<{ name?: string; type?: string; options?: { path?: string } }> };

const PROVIDER_FILE = "config/grafana/qayaba-evaluations.yaml";
const DASHBOARD_FILE = "config/grafana/dashboards/qayaba-evaluations.json";
const DASHBOARD_MOUNT = "/otel-lgtm/qayaba-dashboards";
/* The provisioning tree the pinned grafana/otel-lgtm image reads (verified on the running container). */
const PROVISIONING_DIR = "/otel-lgtm/grafana/conf/provisioning/dashboards";

const compose = parse(read("docker-compose.telemetry.yml"), { merge: true }) as Compose;
const lgtmVolumes = compose.services.lgtm?.volumes ?? [];
const provider = parse(read(PROVIDER_FILE)) as Provider;
const dashboard = JSON.parse(read(DASHBOARD_FILE)) as Dashboard;
const targets = (dashboard.panels ?? []).flatMap((panel) => panel.targets ?? []);

test("the LGTM service mounts the provider where the image reads it and the dashboard where the provider points", () => {
  assert.ok(lgtmVolumes.includes(`./${PROVIDER_FILE}:${PROVISIONING_DIR}/qayaba-evaluations.yaml:ro`), "provider is not mounted at the image's provisioning path");
  assert.ok(lgtmVolumes.includes("./config/grafana/dashboards:/otel-lgtm/qayaba-dashboards:ro"), "dashboard directory is not mounted read-only");
});

test("the provider serves the dashboard directory as files", () => {
  const entry = provider.providers?.[0];
  assert.equal(provider.providers?.length, 1);
  assert.equal(entry?.type, "file");
  assert.equal(entry?.options?.path, DASHBOARD_MOUNT);
  assert.ok(lgtmVolumes.some((mount) => mount.startsWith("./config/grafana/dashboards:")));
});

test("the dashboard is a valid file for the provider and every panel queries Prometheus", () => {
  assert.equal(dashboard.uid, "qayaba-evaluations");
  assert.equal(dashboard.title, "QAYABA evaluations");
  assert.ok((dashboard.panels ?? []).length >= 8);
  for (const panel of dashboard.panels ?? []) {
    assert.equal(panel.datasource?.uid, "prometheus", panel.title);
    assert.ok((panel.targets ?? []).length > 0, `${panel.title} has no query`);
    for (const target of panel.targets ?? []) {
      assert.equal(target.datasource?.uid, "prometheus", panel.title);
      assert.ok(target.expr && target.expr.length > 0, `${panel.title} has an empty query`);
    }
  }
});

test("every metric the evaluations dashboard needs is queried, by bounded labels only", () => {
  const exprs = targets.map((t) => t.expr ?? "").join("\n");
  for (const needle of [
    "qayaba_eval_score",
    "qayaba_eval_class_total",
    "qayaba_budget_exhausted_total",
    "qayaba_runs_total",
    'qayaba_eval_name="spec_validity_rate"',
    'qayaba_eval_name="spec_pass_rate"',
    'qayaba_eval_name="empty_output_guard"',
    'qayaba_eval_name="approval_consistent"',
    'qayaba_eval_name="furthest_phase"',
    'qayaba_eval_name="infra_error"',
    "step_intent_mix",
  ]) {
    assert.ok(exprs.includes(needle), `the dashboard does not query ${needle}`);
  }
  for (const unbounded of ["qayaba_run_id", "qayaba_commit_sha", "qayaba_comment", "qayaba_observation_id"]) {
    assert.ok(!exprs.includes(unbounded), `${unbounded} must never be a metric label`);
  }
});

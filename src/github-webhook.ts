type Data = Record<string, unknown>;
const data = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const short = (value: unknown, limit = 240): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return;
  const chars = Array.from(value);
  return chars.length > limit ? chars.slice(0, limit).join("") + "… [truncated]" : value;
};
const compact = (value: Data): Data => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "" &&
  (!Array.isArray(item) || item.length > 0) && (typeof item !== "object" || Array.isArray(item) || Object.keys(item).length > 0)));
const names = (value: unknown, key: string) => list(value).slice(0, 10).map(item => short(data(item)[key])).filter(value => value !== undefined);
const entity = (value: unknown, includeDetails: boolean): Data => {
  const item = data(value);
  return compact({ number: number(item.number), title: short(item.title), url: short(item.html_url, 600),
    ...(includeDetails ? { labels: names(item.labels, "name"), assignees: names(item.assignees, "login") } : {}),
    ...(typeof item.merged === "boolean" && item.merged ? { merged: true } : {}) });
};
const comment = (value: unknown): Data => {
  const item = data(value);
  return compact({ state: short(item.state), url: short(item.html_url, 600), path: short(item.path), line: number(item.line) });
};

/** GitHub's event header selects a field allowlist. Never dump hook configuration or API metadata. */
export function githubWebhook(payload: unknown, event?: string): unknown {
  if (!event || !/^[a-z][a-z0-9_]{0,63}$/.test(event)) return payload;
  const p = data(payload), action = short(p.action, 64);
  const summary: Data = compact({ event: event + (action ? `.${action}` : ""), repository: short(data(p.repository).full_name), actor: short(data(p.sender).login) });
  if (p.issue) summary[data(data(p.issue).pull_request).url ? "pull_request" : "issue"] = entity(p.issue, !p.comment);
  if (p.pull_request) {
    const pr = data(p.pull_request);
    summary.pull_request = compact({ ...entity(pr, !p.comment && !p.review), head: short(data(pr.head).label ?? data(pr.head).ref), base: short(data(pr.base).ref) });
  }
  if (p.discussion) summary.discussion = entity(p.discussion, !p.comment);
  if (p.comment) summary.comment = comment(p.comment);
  if (p.review) summary.review = comment(p.review);
  if (p.label) summary.label = short(data(p.label).name);
  if (p.assignee) summary.assignee = short(data(p.assignee).login);
  if (p.milestone) summary.milestone = short(data(p.milestone).title);
  if (event === "push") {
    const commits = list(p.commits);
    Object.assign(summary, compact({ ref: short(p.ref), forced: p.forced === true ? true : undefined, deleted: p.deleted === true ? true : undefined,
      commit_count: commits.length, compare: short(p.compare, 600),
      commits: commits.slice(0, 5).map(value => { const commit = data(value); return compact({ sha: short(commit.id)?.slice(0, 12), message: short(typeof commit.message === "string" ? commit.message.split(/\r?\n/)[0] : undefined) }); }),
      more_commits: commits.length > 5 ? commits.length - 5 : undefined }));
  }
  if (p.workflow_run || p.workflow_job || p.check_run || p.check_suite) {
    const field = p.workflow_job ? "workflow_job" : p.workflow_run ? "workflow_run" : p.check_run ? "check_run" : "check_suite";
    const run = data(p[field]), output = data(run.output);
    summary[field] = compact({ name: short(run.name ?? data(p.workflow).name ?? data(run.app).name), status: short(run.status), conclusion: short(run.conclusion),
      branch: short(run.head_branch), commit: short(run.head_sha)?.slice(0, 12), url: short(run.html_url ?? run.details_url, 600),
      title: short(output.title), summary: short(output.summary, 1000),
      failed_steps: list(run.steps).filter(step => ["failure", "cancelled", "timed_out"].includes(String(data(step).conclusion))).slice(0, 5).map(step => short(data(step).name)).filter(name => name !== undefined) });
  }
  if (event === "status") Object.assign(summary, compact({ context: short(p.context), state: short(p.state), description: short(p.description), commit: short(p.sha)?.slice(0, 12), url: short(p.target_url, 600) }));
  if (p.release) {
    const release = data(p.release);
    summary.release = compact({ tag: short(release.tag_name), name: short(release.name), url: short(release.html_url, 600) });
  }
  if (event === "create" || event === "delete") Object.assign(summary, compact({ ref: short(p.ref), ref_type: short(p.ref_type) }));
  if (event === "ping") summary.message = "Webhook connected.";
  // Unrecognized events still carry their event/repository/actor; never fall back to the noisy raw payload.
  return compact(summary);
}

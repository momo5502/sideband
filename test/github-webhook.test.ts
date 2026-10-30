import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { githubWebhook } from "../src/github-webhook.js";
import { webhookText } from "../src/webhooks.js";
import { MAX_TEXT_BYTES } from "../src/room-protocol.js";

const metadata = { id: 123, node_id: "node-noise", avatar_url: "avatar-noise", followers_url: "followers-noise", subscriptions_url: "subscriptions-noise" };
const context = { repository: { ...metadata, full_name: "momo5502/sogen", license: { ...metadata }, owner: { ...metadata } }, sender: { ...metadata, login: "momo5502" } };
const issue = { ...metadata, number: 1720, title: "Test issue", html_url: "https://github.com/momo5502/sogen/issues/1720", body: null, labels: [], reactions: { url: "reactions-noise" }, user: { ...metadata } };

test("GitHub issue-opened payload keeps task details and removes repository/user API metadata", () => {
  const payload = { ...context, action: "opened", issue };
  const expected = { event: "issues.opened", repository: "momo5502/sogen", actor: "momo5502", issue: { number: 1720, title: "Test issue", url: issue.html_url } };
  assert.deepEqual(githubWebhook(payload, "issues"), expected);
  const rendered = webhookText(payload, "issues");
  assert.deepEqual(parse(rendered.slice(8, -4)), expected); assert.ok(rendered.length < 300);
  assert.ok(!rendered.includes("noise")); assert.ok(!rendered.includes("null")); assert.ok(!rendered.includes("[]"));
  const changed = githubWebhook({ ...payload, issue: { ...issue, body: "Please fix the crash.\nReproduction steps here.", labels: [{ name: "bug" }], assignees: [{ login: "worker" }] }, assignee: { login: "worker", ...metadata } }, "issues") as any;
  assert.equal(changed.issue.body, "Please fix the crash.\nReproduction steps here."); assert.deepEqual(changed.issue.labels, ["bug"]); assert.deepEqual(changed.issue.assignees, ["worker"]); assert.equal(changed.assignee, "worker");
});

test("PRs, issue/PR comments and reviews preserve actionable content without repeating parent bodies", () => {
  const pr = { ...issue, html_url: "https://github.com/momo5502/sogen/pull/1720", merged: true, head: { ref: "fix", label: "contributor:fix", repo: context.repository }, base: { ref: "main", repo: context.repository }, body: "Parent body" };
  const merged = githubWebhook({ ...context, action: "closed", pull_request: pr }, "pull_request") as any;
  assert.equal(merged.pull_request.merged, true); assert.equal(merged.pull_request.head, "contributor:fix"); assert.equal(merged.pull_request.base, "main");
  const result = githubWebhook({ ...context, action: "created", issue: { ...issue, body: "Do not repeat", pull_request: { url: "api" } }, comment: { ...metadata, body: "Please retry CI.", html_url: "https://github.com/comment" } }, "issue_comment") as any;
  assert.equal(result.issue, undefined); assert.equal(result.pull_request.number, 1720); assert.equal(result.pull_request.body, undefined); assert.equal(result.comment.body, "Please retry CI.");
  const review = githubWebhook({ ...context, action: "submitted", pull_request: pr, review: { state: "changes_requested", body: "Handle the null case.", html_url: "https://github.com/review" } }, "pull_request_review") as any;
  assert.equal(review.review.state, "changes_requested"); assert.equal(review.review.body, "Handle the null case."); assert.equal(review.pull_request.body, undefined);
  const inline = githubWebhook({ ...context, action: "created", pull_request: pr, comment: { body: "Off by one.", path: "src/main.cpp", line: 42, html_url: "https://github.com/comment", diff_hunk: "large diff" } }, "pull_request_review_comment") as any;
  assert.equal(inline.comment.path, "src/main.cpp"); assert.equal(inline.comment.line, 42); assert.equal(inline.comment.diff_hunk, undefined);
});

test("GitHub CI summaries retain failure context, branch, commit and links while dropping runner metadata", () => {
  const run = { ...metadata, name: "CI", status: "completed", conclusion: "failure", head_branch: "main", head_sha: "0123456789abcdef", html_url: "https://github.com/actions/runs/123", repository: context.repository };
  const workflow = githubWebhook({ ...context, action: "completed", workflow_run: run }, "workflow_run") as any;
  assert.deepEqual(workflow.workflow_run, { name: "CI", status: "completed", conclusion: "failure", branch: "main", commit: "0123456789ab", url: run.html_url });
  const job = githubWebhook({ ...context, action: "completed", workflow_job: { ...run, runner_name: "runner-noise", steps: [{ name: "Checkout", conclusion: "success" }, { name: "Tests", conclusion: "failure" }, { name: "Cleanup", conclusion: "skipped" }] } }, "workflow_job") as any;
  assert.deepEqual(job.workflow_job.failed_steps, ["Tests"]); assert.ok(!JSON.stringify(job).includes("runner-noise"));
  for (const event of ["check_run", "check_suite"]) {
    const check = githubWebhook({ ...context, action: "completed", [event]: { ...run, output: { title: "Tests failed", summary: "test_parse crashed", text: "Do not dump logs" } } }, event) as any;
    assert.equal(check[event].summary, "test_parse crashed"); assert.equal(check[event].text, undefined);
  }
  const status = githubWebhook({ ...context, context: "build", state: "failure", description: "Compilation failed", sha: "0123456789abcdef", target_url: "https://ci.test/build" }, "status") as any;
  assert.equal(status.state, "failure"); assert.equal(status.context, "build"); assert.equal(status.url, "https://ci.test/build");
});

test("GitHub pushes summarize commit subjects and cap commit lists instead of dumping changed files", () => {
  const commits = Array.from({ length: 8 }, (_, i) => ({ id: `abcdef0123456789${i}`, message: `Fix ${i}\n\nLong explanation`, added: ["path-noise"], author: metadata }));
  const result = githubWebhook({ ...context, ref: "refs/heads/main", compare: "https://github.com/compare", forced: true, commits }, "push") as any;
  assert.equal(result.commit_count, 8); assert.equal(result.more_commits, 3); assert.equal(result.commits.length, 5); assert.equal(result.forced, true);
  assert.deepEqual(result.commits[0], { sha: "abcdef012345", message: "Fix 0" }); assert.ok(!JSON.stringify(result).includes("path-noise"));
  const deleted = githubWebhook({ ...context, ref: "refs/heads/old", deleted: true, head_commit: null, commits: [] }, "push") as any;
  assert.equal(deleted.deleted, true); assert.equal(deleted.commit_count, 0); assert.equal(deleted.commits, undefined);
});

test("GitHub ping, releases, refs and unknown events never dump webhook configuration or raw object trees", () => {
  const ping = githubWebhook({ ...context, hook: { config: { url: "secret-webhook-url", secret: "secret-value" } } }, "ping") as any;
  assert.equal(ping.message, "Webhook connected."); assert.ok(!JSON.stringify(ping).includes("secret"));
  const release = githubWebhook({ ...context, action: "published", release: { tag_name: "v1", name: "First release", body: "Changes", html_url: "https://github.com/release", assets: [metadata] } }, "release") as any;
  assert.equal(release.release.tag, "v1"); assert.equal(release.release.body, "Changes"); assert.equal(release.release.assets, undefined);
  assert.equal((githubWebhook({ ref: "feature", ref_type: "branch" }, "create") as any).ref, "feature");
  assert.deepEqual(githubWebhook({ ...context, action: "new", hook: { config: { secret: "never-forward" } } }, "future_event"), { event: "future_event.new", repository: "momo5502/sogen", actor: "momo5502" });
  assert.deepEqual(githubWebhook(null, "issues"), { event: "issues" });
  for (const event of [undefined, "", "not a valid event", "x".repeat(65)]) assert.deepEqual(githubWebhook(context, event), context);
  assert.deepEqual(parse(webhookText(context).slice(8, -4)), context, "generic payloads stay intact without GitHub's header");
});

test("long GitHub bodies remain bounded readable YAML with explicit field truncation", () => {
  const rendered = webhookText({ ...context, action: "opened", issue: { ...issue, body: "🚀".repeat(3000) } }, "issues");
  assert.ok(Buffer.byteLength(rendered) <= MAX_TEXT_BYTES); assert.match(rendered, /truncated/); assert.ok(!rendered.includes("\uFFFD"));
  const shortBody = webhookText({ ...context, action: "created", issue, comment: { body: "a".repeat(4000) } }, "issue_comment");
  const parsed = parse(shortBody.slice(8, -4)); assert.equal(parsed.comment.body, "a".repeat(2000) + "… [truncated]");
});

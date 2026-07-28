import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReports } from "../stParser";

const SAMPLE = [
  "# AI-oriented error reports (format st/1, https://github.com/stacktale/stacktale)",
  "━━━ ERROR #c73cf755 ━━━ 2026-07-10 20:16:40.412 thread=http-nio-8080-exec-2 ━━━",
  'NullPointerException: "customer" is null',
  "at PaymentService.charge(PaymentService.java:44) ← YOUR CODE",
  "wrapped by: CheckoutException(\"checkout failed\") at CheckoutService.confirm(CheckoutService.java:88)",
  "",
  "env: app=shop-api 1.4.2 | java 21 | prod",
  "━━━ END #c73cf755 ━━━",
].join("\n");

test("parses id, timestamp, headline and the culprit frame", () => {
  const reports = parseReports(SAMPLE);
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.id, "c73cf755");
  assert.equal(r.timestamp, "2026-07-10 20:16:40.412");
  assert.match(r.headline, /NullPointerException/);
  assert.ok(r.culprit, "a culprit frame was found");
  assert.equal(r.culprit!.file, "PaymentService.java");
  assert.equal(r.culprit!.line, 44);
});

test("prefers the ← YOUR CODE frame over the first frame", () => {
  const content = [
    "━━━ ERROR #aaaa1111 ━━━ 2026-07-10 10:00:00.000 thread=main ━━━",
    "IllegalStateException: boom",
    "at framework.Filter.doFilter(Filter.java:9)",
    "at com.acme.Svc.run(Svc.java:51) ← YOUR CODE",
    "━━━ END #aaaa1111 ━━━",
  ].join("\n");
  const r = parseReports(content)[0];
  assert.equal(r.culprit!.file, "Svc.java");
  assert.equal(r.culprit!.line, 51);
});

test("ignores the file header's mid-line quote of the delimiter", () => {
  const content = [
    '# Each report is delimited by "━━━ ERROR #<id> ━━━" ... "━━━ END #<id> ━━━".',
    "━━━ ERROR #bbbb2222 ━━━ 2026-07-10 11:00:00.000 thread=worker ━━━",
    "RuntimeException: nope",
    "━━━ END #bbbb2222 ━━━",
  ].join("\n");
  const reports = parseReports(content);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, "bbbb2222");
});

test("keeps reports that do not contain a source frame", () => {
  const content = [
    "━━━ ERROR #cccc3333 ━━━ 2026-07-10 12:00:00.000 thread=main ━━━",
    "ERROR (no exception): payment timed out",
    "env: app=shop-api 1.4.2 | java 21 | prod",
    "━━━ END #cccc3333 ━━━",
  ].join("\n");

  const reports = parseReports(content);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, "cccc3333");
  assert.equal(reports[0].frames.length, 0);
  assert.equal(reports[0].culprit, undefined);
});

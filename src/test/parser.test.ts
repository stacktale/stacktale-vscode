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

test("parses st-json/1 reports and ignores non-report and torn entries", () => {
  const content = [
    '  {"type":"header","format":"st-json/1"}',
    JSON.stringify({
      type: "report",
      id: "json0001",
      ts: "2026-07-10T20:16:40.412Z",
      thread: "main",
      error: {
        type: "IllegalStateException",
        message: "payment gateway refused",
        culprit: {
          frame: "PaymentService.charge(PaymentService.java:44)",
          appCode: true,
        },
      },
      stack: {
        shown: 1,
        total: 1,
        frames: ["PaymentService.charge(PaymentService.java:44)"],
      },
    }),
    '{"type":"repeat","id":"json0001","count":3,"last":"2026-07-10T20:17:30.000Z"}',
    '{"type":"report","id":"half-written"',
  ].join("\n");

  const reports = parseReports(content);
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.id, "json0001");
  assert.equal(r.timestamp, "2026-07-10 20:16:40.412");
  assert.equal(r.headline, "IllegalStateException: payment gateway refused");
  assert.equal(r.culprit?.file, "PaymentService.java");
  assert.equal(r.culprit?.line, 44);
  assert.equal(JSON.parse(r.block).type, "report");
});

test("maps an st-json/1 no-exception report", () => {
  const content = JSON.stringify({
    type: "report",
    id: "json0002",
    ts: "2026-07-10T20:17:01.000Z",
    thread: "worker-1",
    error: { noException: true, message: "checkout timed out" },
  });

  const reports = parseReports(content);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].headline, "ERROR (no exception): checkout timed out");
  assert.equal(reports[0].frames.length, 0);
  assert.equal(reports[0].culprit, undefined);
});

// The three bugs from #5, mirroring the fix landed in the JetBrains plugin (its PR #11).
// The two parsers are deliberate twins; these cases must behave identically in both.

test("discards a truncated block and still parses the next complete one", () => {
  const truncated =
    "━━━ ERROR #dead ━━━ 2026-07-10 20:18:00.000 thread=main ━━━\n" +
    "RuntimeException: boom\n" +
    "at Svc.run(Svc.java:12) ← YOUR CODE\n";

  assert.equal(parseReports(truncated).length, 0);

  const followed =
    truncated +
    "━━━ ERROR #beef ━━━ 2026-07-10 20:19:00.000 thread=main ━━━\n" +
    "RuntimeException: complete\n" +
    "at GoodService.run(GoodService.java:7) ← YOUR CODE\n" +
    "━━━ END #beef ━━━\n";

  const reports = parseReports(followed);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, "beef");
});

test("a marked frame with no line number does not fall back to another file", () => {
  // -1 is what the JVM reports for a class compiled without -g:lines
  const content = [
    "━━━ ERROR #nodebug ━━━ 2026-07-10 20:20:00.000 thread=main ━━━",
    "IllegalStateException: wrapped failure",
    "wrapped by: CheckoutException at CheckoutService.confirm(CheckoutService.java:88)",
    "at OrderService.confirm(OrderService.java:-1) ← YOUR CODE",
    "━━━ END #nodebug ━━━",
  ].join("\n");

  const r = parseReports(content)[0];
  assert.equal(r.culprit, undefined);
  assert.deepEqual(r.frames.map((f) => f.file), ["CheckoutService.java"]);
});

test("parses unicode filenames and .kts frames", () => {
  const content = [
    "━━━ ERROR #unicode ━━━ 2026-07-10 20:22:00.000 thread=main ━━━",
    "RuntimeException: unicode filename",
    "at Ação.run(Ação.java:23) ← YOUR CODE",
    "━━━ END #unicode ━━━",
    "━━━ ERROR #script ━━━ 2026-07-10 20:23:00.000 thread=main ━━━",
    "RuntimeException: kotlin script",
    "at 構建.run(構建.kts:9) ← YOUR CODE",
    "━━━ END #script ━━━",
  ].join("\n");

  const reports = parseReports(content);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].culprit?.file, "Ação.java");
  assert.equal(reports[0].culprit?.line, 23);
  assert.equal(reports[1].culprit?.file, "構建.kts");
  assert.equal(reports[1].culprit?.line, 9);
});

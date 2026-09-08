import assert from "node:assert/strict";
import { enrichAgyResult, extractAgyFailure, sanitizeDiagnostics } from "../src/diagnostics.mjs";
import { isRetryablePreflightFailure } from "../src/process-control.mjs";

const locationLog = [
  "agent executor error: calling model: FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
  "calling model: FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
].join("\n");
const locationFailure = extractAgyFailure(locationLog);
assert.deepEqual(locationFailure, {
  layer: "gemini_model_backend",
  code: "FAILED_PRECONDITION",
  http_status: 400,
  reason: "USER_LOCATION_NOT_SUPPORTED",
  message: "User location is not supported for the API use.",
});

const enrichedLocation = enrichAgyResult(
  { status: "ERROR", response: "", error: "Agent execution terminated due to error." },
  locationLog,
);
assert.match(enrichedLocation.error, /FAILED_PRECONDITION \(HTTP 400\)/);
assert.equal(enrichedLocation.error_details.reason, "USER_LOCATION_NOT_SUPPORTED");

const deniedLog = 'Print mode: soft-denying tool confirmation "RunCommand" at step 4';
const enrichedDenial = enrichAgyResult(
  { status: "SUCCESS", response: "" },
  deniedLog,
);
assert.equal(enrichedDenial.status, "ERROR");
assert.equal(enrichedDenial.error_details.code, "TOOL_CONFIRMATION_DENIED");
assert.equal(enrichedDenial.error_details.tool, "RunCommand");

const recovered = enrichAgyResult({ status: "SUCCESS", response: "done" }, locationLog);
assert.equal(recovered.status, "SUCCESS");
assert.equal(recovered.diagnostic_warning.code, "FAILED_PRECONDITION");
assert.equal(enrichAgyResult({ status: "SUCCESS", response: "" }, locationLog).status, "SUCCESS");
assert.equal(extractAgyFailure(locationLog + "\n" + "x".repeat(20_000)).code, "FAILED_PRECONDITION");
assert.equal(enrichAgyResult({ status: "SUCCESS", response: "" }, locationLog + "\n" + deniedLog).error_details.code, "TOOL_CONFIRMATION_DENIED");

for (const value of [
  'authorization: Bearer FAKE_SECRET_123',
  'Authorization: Basic FAKE_SECRET_123',
  '{"access_token":"FAKE_SECRET_123"}',
  "refresh-token='FAKE_SECRET_123'",
  'https://example.test/?api_key=FAKE_SECRET_123&other=1',
]) {
  assert(!sanitizeDiagnostics(value).includes("FAKE_SECRET_123"));
  assert(!enrichAgyResult({ status: "ERROR", error: value }, "").error.includes("FAKE_SECRET_123"));
}

for (const usage of [undefined, {}, { total_tokens: 0 }, { total_tokens: 10 }]) {
  assert.equal(isRetryablePreflightFailure({ state: "error", result: { status: "ERROR", usage } }), false);
}
assert.equal(isRetryablePreflightFailure({ state: "error", preflightConfirmed: true, spawnErrorCode: "EAGAIN" }), true);
assert.equal(isRetryablePreflightFailure({ state: "error", preflightConfirmed: true, spawnErrorCode: "ENOENT" }), false);
assert.equal(isRetryablePreflightFailure({ state: "error", preflightConfirmed: true, spawnErrorCode: "EAGAIN", cancelRequested: true }), false);
process.stdout.write("diagnostics and retry regression tests passed\n");

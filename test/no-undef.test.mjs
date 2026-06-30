// Guardrail test: statically fail the build if any source file references an identifier that is never
// declared (e.g. a render helper used in a template literal but never defined) — the class of bug that
// surfaces at runtime as `ReferenceError: x is not defined`. We run ESLint's `no-undef` over src/ via
// its Node API and assert zero violations, so `node --test` / `npm test` catches it before it ships.
//
// This is a correctness gate, not a style gate: only `no-undef` is enabled (see eslint.config.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";

test("src/ has no undefined identifier references (no-undef)", async () => {
  const eslint = new ESLint();
  const results = await eslint.lintFiles(["src/**/*.{js,mjs}"]);

  const violations = [];
  for (const r of results) {
    for (const m of r.messages) {
      if (m.ruleId === "no-undef" || m.fatal) {
        violations.push(`${r.filePath}:${m.line}:${m.column}  ${m.message}`);
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    `Undefined identifier reference(s) found — these throw ReferenceError at runtime:\n` + violations.join("\n")
  );
});

test("the no-undef gate actually fires on an undefined reference", async () => {
  // Self-check: prove the lint catches a genuinely-undefined identifier, so a green run above is
  // meaningful rather than a misconfigured rule silently passing everything.
  const eslint = new ESLint();
  const [result] = await eslint.lintText("const html = `${missingHelper()}`;\nexport { html };\n", {
    filePath: "probe.mjs",
  });
  const hit = result.messages.some((m) => m.ruleId === "no-undef" && /missingHelper/.test(m.message));
  assert.ok(hit, "expected no-undef to flag an undefined identifier, but it did not — config is broken");
});

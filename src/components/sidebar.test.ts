import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./sidebar.tsx", import.meta.url), "utf8");

test("sign out goes through next-auth signOut (sends the CSRF token), not a bare form POST", () => {
  assert.match(source, /import \{ signOut \} from "next-auth\/react"/);
  assert.match(source, /onClick=\{\(\) => void signOut\(\{ callbackUrl: "\/" \}\)\}/);
  assert.doesNotMatch(source, /action="\/api\/auth\/signout"/);
});

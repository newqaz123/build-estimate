import assert from "node:assert/strict";
import test from "node:test";

import { resolveActorId } from "@/lib/auth-actor";

test("resolveActorId returns null when there is no authenticated user", () => {
	assert.equal(resolveActorId(null), null);
	assert.equal(resolveActorId(undefined), null);
	assert.equal(resolveActorId({}), null);
	assert.equal(resolveActorId({ user: null }), null);
	assert.equal(resolveActorId({ user: "admin" as unknown as object }), null);
});

test("resolveActorId prefers a non-empty user.id", () => {
	assert.equal(
		resolveActorId({ user: { id: "user-1", email: "a@b.c" } }),
		"user-1",
	);
	assert.equal(resolveActorId({ user: { id: "  admin  " } }), "admin");
});

test("resolveActorId falls back to anonymous for logged-in JWT sessions missing id", () => {
	// Matches Auth.js default session.user shape before a session callback copies token.sub.
	assert.equal(
		resolveActorId({
			user: { name: "Admin", email: "admin@buildestimate.app" },
		}),
		"anonymous",
	);
	assert.equal(resolveActorId({ user: {} }), "anonymous");
	assert.equal(resolveActorId({ user: { id: "" } }), "anonymous");
	assert.equal(resolveActorId({ user: { id: "   " } }), "anonymous");
});

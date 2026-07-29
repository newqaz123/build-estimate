/**
 * Resolve a stable owner id from an Auth.js / NextAuth session.
 *
 * Preflight ownership and import consumption must use the same key. Auth.js JWT
 * sessions do not expose `user.id` unless a session callback copies `token.sub`,
 * so callers historically fell back to "anonymous" once a user object existed.
 */
export function resolveActorId(
	session: { user?: unknown } | null | undefined,
): string | null {
	if (!session || typeof session !== "object") return null;
	const user = session.user;
	if (typeof user !== "object" || user === null) return null;

	const id = (user as { id?: unknown }).id;
	if (typeof id === "string" && id.trim() !== "") return id.trim();

	// Logged-in session without an id field (default Auth.js JWT shape).
	return "anonymous";
}

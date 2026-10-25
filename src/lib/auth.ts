import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyAdminPassword } from "@/lib/admin-password";

declare module "next-auth" {
	interface Session {
		user: {
			id: string;
			name?: string | null;
			email?: string | null;
			image?: string | null;
		};
	}
}

export const { handlers, signIn, signOut, auth } = NextAuth({
	providers: [
		Credentials({
			credentials: {
				password: { label: "Password", type: "password" },
			},
			async authorize(credentials) {
				if (verifyAdminPassword(credentials?.password)) {
					return {
						id: "1",
						name: "Admin",
						email: "admin@buildestimate.app",
					};
				}
				return null;
			},
		}),
	],
	pages: { signIn: "/" },
	session: { strategy: "jwt" },
	callbacks: {
		// Auth.js JWT sessions omit user.id unless we copy token.sub onto the session.
		// Preflight ownership and import consumption both require a stable actor id.
		jwt({ token, user }) {
			if (user?.id) token.sub = user.id;
			return token;
		},
		session({ session, token }) {
			if (session.user) {
				session.user.id =
					typeof token.sub === "string" && token.sub.trim() !== ""
						? token.sub
						: "anonymous";
			}
			return session;
		},
		authorized({ auth, request: { nextUrl } }) {
			const isLoggedIn = Boolean(auth?.user);
			const isOnPublicPage = nextUrl.pathname === "/";
			const isOnAuthApi = nextUrl.pathname.startsWith("/api/auth");
			if (isOnPublicPage || isOnAuthApi) return true;
			if (isLoggedIn) return true;
			return false;
		},
	},
});

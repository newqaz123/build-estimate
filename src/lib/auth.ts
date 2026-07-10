import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (credentials?.password === process.env.ADMIN_PASSWORD) {
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
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnPublicPage = nextUrl.pathname === "/";
      const isOnAuthApi = nextUrl.pathname.startsWith("/api/auth");
      if (isOnPublicPage || isOnAuthApi) return true;
      if (isLoggedIn) return true;
      return false;
    },
  },
});

// Next 16 renamed the `middleware` file convention to `proxy`; the exported
// function must be named `proxy` (or be the default export).
export { auth as proxy } from "@/lib/auth";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};

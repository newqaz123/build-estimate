import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist is a browser library that we run server-side for preflight page
  // analysis. Its main entry references DOMMatrix and its worker loader performs
  // dynamic imports that Turbopack intercepts/rewrites. Loading it as a native
  // Node module (instead of bundling) lets its own legacy-build worker machinery
  // resolve correctly under Node.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;

"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const result = await signIn("credentials", {
      password,
      redirect: false,
    });
    if (result?.error) {
      setError("Invalid password. Try again.");
      setLoading(false);
    } else {
      router.push("/dashboard");
    }
  }

  return (
    <div className="flex min-h-screen">
      <div className="flex-1 flex flex-col justify-center items-center p-12 bg-[#181d26] text-white">
        <svg viewBox="0 0 40 40" fill="none" className="w-10 h-10 text-accent mb-4">
          <rect width="40" height="40" rx="10" fill="currentColor" />
          <path d="M12 24l8-16 8 16" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10 28h20" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
        </svg>
        <h1 className="font-display text-3xl font-semibold mb-2">BuildEstimate</h1>
        <p className="text-white/60 text-sm max-w-xs text-center leading-relaxed">
          BOQ management &amp; price comparison for construction consultants. Upload, compare, and estimate — all in one place.
        </p>
      </div>

      <div className="flex-1 flex flex-col justify-center items-center p-12 bg-background" data-od-id="login-form-wrap">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-semibold mb-1">Sign in</h2>
          <p className="text-sm text-muted-foreground mb-6">Enter your credentials to continue.</p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                type="email"
                defaultValue="admin@buildestimate.app"
                className="h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
                autoComplete="current-password"
                required
              />
            </div>

            {error && (
              <div className="text-sm text-destructive text-center p-2 rounded-lg bg-destructive/10">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="h-11 w-full flex items-center justify-center rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer border-none"
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

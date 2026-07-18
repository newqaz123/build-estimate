"use client";

import { signIn } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submissionInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const router = useRouter();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submissionInFlightRef.current) return;

    submissionInFlightRef.current = true;
    setLoading(true);
    setError("");
    let navigationStarted = false;

    try {
      const result = await signIn("credentials", {
        password,
        redirect: false,
      });

      if (result?.ok && !result.error) {
        navigationStarted = true;
        router.push("/dashboard");
        return;
      }

      if (mountedRef.current) {
        setError("Invalid password. Try again.");
      }
    } catch {
      if (mountedRef.current) {
        setError("Unable to sign in right now. Please try again.");
      }
    } finally {
      if (!navigationStarted) {
        submissionInFlightRef.current = false;
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand" data-od-id="login-brand">
        <svg viewBox="0 0 40 40" fill="none" className="brand-icon" aria-hidden="true">
          <rect width="40" height="40" rx="10" fill="currentColor" />
          <path d="M12 24l8-16 8 16" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M10 28h20" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
        </svg>
        <h1>BuildEstimate</h1>
        <p>
          BOQ management &amp; price comparison for construction consultants. Upload, compare, and estimate — all in one place.
        </p>
      </section>

      <section className="login-form-wrap" data-od-id="login-form-wrap">
        <h2>Sign in</h2>
        <p className="lead">Enter your credentials to continue.</p>

        <form className="login-form" onSubmit={handleSubmit} aria-busy={loading} data-od-id="login-form">
          <div className="proto-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              defaultValue="admin@buildestimate.app"
              className="proto-input"
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </div>

          <div className="proto-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="proto-input"
              placeholder="Enter your password"
              autoComplete="current-password"
              required
              aria-describedby={error ? "login-error" : undefined}
              aria-invalid={Boolean(error)}
            />
          </div>

          <div className="login-form-footer">
            <button
              type="submit"
              disabled={loading}
              aria-label={loading ? "Signing in" : "Sign in"}
              className={`btn btn-primary btn-lg login-submit${loading ? " loading" : ""}`}
              data-od-id="login-submit"
            >
              <span role="status" aria-live="polite">
                {loading ? "Signing in..." : "Sign in"}
              </span>
            </button>

            {error && (
              <div id="login-error" className="form-error" role="alert">
                {error}
              </div>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}

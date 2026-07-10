"use client";

import Link from "next/link";

export function Topbar({
  title,
  backHref,
}: {
  title?: string;
  backHref?: string;
}) {
  return (
    <header
      data-od-id="topbar"
      className="h-14 border-b border-border flex items-center justify-between px-5 bg-background shrink-0"
    >
      <div className="flex items-center gap-3">
        {backHref && (
          <Link
            href={backHref}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground no-underline"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-4 h-4"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </Link>
        )}
        {title && <h1 className="text-lg font-semibold tracking-tight">{title}</h1>}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">Construction Consultant</span>
        <div className="w-8 h-8 rounded-full bg-[#e8f0fe] grid place-items-center text-xs font-semibold text-accent">
          CC
        </div>
      </div>
    </header>
  );
}

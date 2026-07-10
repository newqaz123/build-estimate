"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ROUTE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/boqs": "Bills of Quantities",
  "/compare": "Compare Quotations",
  "/catalog": "Catalog",
  "/estimator": "Estimator",
  "/settings": "Settings",
};

function deriveTitle(pathname: string): { title: string; backHref?: string } {
  if (ROUTE_TITLES[pathname]) return { title: ROUTE_TITLES[pathname] };
  if (pathname.startsWith("/boqs/")) return { title: "BOQ Detail", backHref: "/boqs" };
  if (pathname.startsWith("/boqs")) return { title: "Bills of Quantities" };
  return { title: "BuildEstimate" };
}

export function Topbar({
  title,
  backHref,
}: {
  title?: string;
  backHref?: string;
}) {
  const pathname = usePathname();
  const derived = title ? { title, backHref } : deriveTitle(pathname);
  const displayTitle = derived.title;
  const displayBackHref = backHref ?? derived.backHref;

  return (
    <header
      data-od-id="topbar"
      className="h-14 border-b border-border flex items-center justify-between px-5 bg-background shrink-0"
    >
      <div className="flex items-center gap-3">
        {displayBackHref && (
          <Link
            href={displayBackHref}
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
        {displayTitle && <h1 className="text-lg font-semibold tracking-tight">{displayTitle}</h1>}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[13px] text-muted-foreground">Construction Consultant</span>
        <div className="w-8 h-8 rounded-full bg-[#e8f0fe] grid place-items-center text-xs font-semibold text-accent">
          CC
        </div>
      </div>
    </header>
  );
}

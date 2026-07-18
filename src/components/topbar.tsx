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
      className="topbar"
    >
      <div className="topbar-left">
        {displayBackHref && (
          <Link
            href={displayBackHref}
            className="topbar-back"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
              focusable="false"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </Link>
        )}
        {displayTitle && <h1>{displayTitle}</h1>}
      </div>
      <div className="topbar-right">
        <span className="topbar-role">Construction Consultant</span>
        <div className="avatar">
          CC
        </div>
      </div>
    </header>
  );
}

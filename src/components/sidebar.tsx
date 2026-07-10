"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  {
    href: "/dashboard",
    label: "Dashboard",
    odId: "nav-dashboard",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
  },
  {
    href: "/boqs",
    label: "BOQs",
    odId: "nav-boqs",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
  {
    href: "/compare",
    label: "Compare",
    odId: "nav-compare",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M16 18l6-6-6-6M5 12h15" />
        <path d="M8 6l-6 6 6 6" />
      </svg>
    ),
  },
  {
    href: "/catalog",
    label: "Catalog",
    odId: "nav-catalog",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
        <line x1="8" y1="7" x2="16" y2="7" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </svg>
    ),
  },
  {
    href: "/estimator",
    label: "Estimator",
    odId: "nav-estimator",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    odId: "nav-settings",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  return (
    <aside
      data-od-id="sidebar"
      className={`${
        collapsed ? "w-[60px] min-w-[60px]" : "w-[240px] min-w-[240px]"
      } bg-[#181d26] text-white/80 flex flex-col overflow-y-auto transition-all duration-200`}
    >
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/8">
        <svg viewBox="0 0 28 28" fill="none" className="w-7 h-7 shrink-0 text-accent">
          <rect width="28" height="28" rx="7" fill="currentColor" />
          <path d="M8 17l6-11 6 11" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6 20h16" stroke="white" strokeWidth="1.8" strokeLinecap="round" opacity="0.5" />
        </svg>
        <span
          className={`font-display text-lg font-semibold text-white tracking-tight whitespace-nowrap overflow-hidden transition-all duration-200 ${
            collapsed ? "opacity-0 w-0 m-0" : "opacity-100"
          }`}
        >
          BuildEstimate
        </span>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={`ml-auto w-6 h-6 grid place-items-center bg-transparent border-none text-white/40 cursor-pointer rounded-md hover:text-white/80 transition-all duration-200 ${
            collapsed ? "rotate-180" : ""
          }`}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      <nav className="flex-1 p-3 flex flex-col gap-0.5">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              data-od-id={item.odId}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-[450] whitespace-nowrap transition-colors duration-150 no-underline ${
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-white/65 hover:bg-white/8 hover:text-white"
              } ${collapsed ? "justify-center px-2 gap-0" : ""}`}
            >
              <span className="w-[18px] h-[18px] shrink-0 opacity-70 [.active_&]:opacity-100 group-hover:opacity-100">
                {item.icon}
              </span>
              <span
                className={`transition-all duration-200 ${
                  collapsed ? "opacity-0 w-0 overflow-hidden m-0" : ""
                }`}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div
        className={`p-3 border-t border-white/8 transition-opacity duration-200 ${
          collapsed ? "opacity-0 pointer-events-none" : ""
        }`}
      >
        <form action="/api/auth/signout" method="POST">
          <button
            type="submit"
            data-od-id="nav-signout"
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-white/65 text-sm hover:bg-white/8 hover:text-white transition-colors duration-150 no-underline cursor-pointer bg-transparent border-none"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-[18px] h-[18px] shrink-0 opacity-70">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}

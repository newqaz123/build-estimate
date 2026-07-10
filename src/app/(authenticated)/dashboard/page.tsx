"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Boq {
  id: string;
  project: string;
  vendor: string;
  workType: "Structural" | "MEP" | "Finishing";
  date: string;
  totalItems: number;
  grandTotal: number;
  status: "draft" | "parsed" | "active" | "review" | "approved" | "rejected";
  updatedAt: string;
}

interface Estimate {
  id: string;
  name: string;
}

interface Vendor {
  id: string;
  name: string;
}

interface DashboardData {
  boqs: Boq[];
  boqTotal: number;
  estimates: number;
  vendors: number;
}

const statusColors: Record<string, string> = {
  draft: "bg-[#666666]",
  parsed: "bg-[#666666]",
  active: "bg-accent",
  review: "bg-[#eab308]",
  approved: "bg-[#006400]",
  rejected: "bg-[#dc2626]",
};

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [boqsRes, estimatesRes, vendorsRes] = await Promise.all([
          fetch("/api/boqs?limit=5"),
          fetch("/api/estimates"),
          fetch("/api/vendors"),
        ]);

        const boqsJson = await boqsRes.json();
        const estimatesJson = await estimatesRes.json();
        const vendorsJson = await vendorsRes.json();

        setData({
          boqs: boqsJson.boqs || [],
          boqTotal: boqsJson.total || 0,
          estimates: (estimatesJson.estimates || []).length,
          vendors: Array.isArray(vendorsJson) ? vendorsJson.length : 0,
        });
      } catch {
        setData({ boqs: [], boqTotal: 0, estimates: 0, vendors: 0 });
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  if (!data || (data.boqTotal === 0 && data.estimates === 0 && data.vendors === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-10 h-10 opacity-40">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
        <p className="text-sm">No data yet. Upload a BOQ to get started.</p>
        <Link href="/boqs" className="text-sm text-accent hover:underline">
          Go to BOQs
        </Link>
      </div>
    );
  }

  const totalItems = data.boqs.reduce((sum, b) => sum + (b.totalItems || 0), 0);

  return (
    <>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="elev-raised rounded-[16px] border border-border bg-card p-5">
          <div className="font-mono text-[40px] font-semibold leading-none tracking-tight text-accent mb-1">
            {data.boqTotal}
          </div>
          <div className="text-sm text-muted-foreground">Total BOQs</div>
        </div>
        <div className="elev-raised rounded-[16px] border border-border bg-card p-5">
          <div className="font-mono text-[40px] font-semibold leading-none tracking-tight text-[#006400] mb-1">
            {totalItems}
          </div>
          <div className="text-sm text-muted-foreground">Total Items</div>
        </div>
        <div className="elev-raised rounded-[16px] border border-border bg-card p-5">
          <div className="font-mono text-[40px] font-semibold leading-none tracking-tight text-[#eab308] mb-1">
            {data.vendors}
          </div>
          <div className="text-sm text-muted-foreground">Vendors</div>
        </div>
        <div className="elev-raised rounded-[16px] border border-border bg-card p-5">
          <div className="font-mono text-[40px] font-semibold leading-none tracking-tight text-accent mb-1">
            {data.estimates}
          </div>
          <div className="text-sm text-muted-foreground">Estimates</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className="elev-raised rounded-[16px] border border-border bg-card">
          <div className="flex items-center justify-between px-5 pt-5 pb-4">
            <h2 className="text-[18px] font-semibold">Recent Activity</h2>
            <Link
              href="/boqs"
              className="text-xs font-medium text-muted-foreground hover:text-accent no-underline"
            >
              View all
            </Link>
          </div>
          <div>
            {data.boqs.length === 0 ? (
              <div className="px-5 pb-5 text-sm text-muted-foreground">No activity yet.</div>
            ) : (
              data.boqs.map((boq) => {
                const dotColor =
                  boq.workType === "MEP"
                    ? "bg-[#eab308]"
                    : boq.workType === "Finishing"
                      ? "bg-[#006400]"
                      : "bg-accent";
                return (
                  <div
                    key={boq.id}
                    className="flex items-start gap-3 px-5 py-3 border-b border-border-soft last:border-b-0"
                  >
                    <div className={`w-2 h-2 rounded-full mt-[6px] shrink-0 ${dotColor}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        BOQ uploaded — {boq.project}
                      </div>
                      <span className="block text-xs text-muted-foreground mt-[2px]">
                        {boq.workType} · {boq.vendor} · {timeAgo(boq.updatedAt)}
                      </span>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full shrink-0 ${
                        boq.status === "active"
                          ? "bg-accent/12 text-accent"
                          : boq.status === "review"
                            ? "bg-[#eab308]/18 text-[#b88a00]"
                            : boq.status === "approved"
                              ? "bg-[#006400]/12 text-[#006400]"
                              : boq.status === "rejected"
                                ? "bg-[#dc2626]/12 text-[#dc2626]"
                                : "bg-[#666666]/12 text-[#666666]"
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${statusColors[boq.status] || statusColors.draft}`} />
                      {boq.status}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="elev-raised rounded-[16px] border border-border bg-card">
          <div className="flex items-center justify-between px-5 pt-5 pb-4">
            <h2 className="text-[18px] font-semibold">Quick Stats</h2>
          </div>
          <div className="px-5 pb-5 space-y-4">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Total Items Across BOQs</div>
              <div className="font-mono text-lg font-semibold">{totalItems}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Comparison Match Rate</div>
              <div className="flex items-center gap-2">
                <div className="font-mono text-lg font-semibold">—</div>
                <span className="text-xs text-muted-foreground">Add BOQs to calculate</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Data Coverage</div>
              <div className="flex items-center gap-2">
                <div className="font-mono text-lg font-semibold">—</div>
                <span className="text-xs text-muted-foreground">Standardize items to calculate</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

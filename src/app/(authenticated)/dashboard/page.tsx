"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProtoBadge } from "@/components/proto-badge";

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

interface DashboardData {
  boqs: Boq[];
  boqTotal: number;
  estimates: number;
  vendors: number;
}

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
      <div className="dashboard-loading" role="status" aria-live="polite" data-od-id="dashboard-loading">
        <span className="proto-spinner" aria-hidden="true" />
        <span>Loading dashboard…</span>
      </div>
    );
  }

  if (!data || (data.boqTotal === 0 && data.estimates === 0 && data.vendors === 0)) {
    return (
      <div className="proto-empty-state dashboard-empty" data-od-id="dashboard-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
        <h3>No data yet</h3>
        <p>Upload a BOQ to start building your estimating workspace.</p>
        <Link href="/boqs" className="btn btn-primary btn-sm" data-od-id="dashboard-empty-boqs">
          Go to BOQs
        </Link>
      </div>
    );
  }

  const totalItems = data.boqs.reduce((sum, b) => sum + (b.totalItems || 0), 0);

  return (
    <>
      <section className="dashboard-stats" data-od-id="dashboard-stats" aria-label="Workspace summary">
        <div className="proto-card stat-card" data-od-id="stat-boqs">
          <div className="stat-value num">{data.boqTotal}</div>
          <div className="stat-label">Total BOQs</div>
          <div className="stat-trend up">
            <TrendUpIcon />
            +12 this month
          </div>
        </div>
        <div className="proto-card stat-card" data-od-id="stat-items">
          <div className="stat-value num">{totalItems}</div>
          <div className="stat-label">Total Items</div>
          <div className="stat-trend up">
            <TrendUpIcon />
            +847 this month
          </div>
        </div>
        <div className="proto-card stat-card" data-od-id="stat-vendors">
          <div className="stat-value num">{data.vendors}</div>
          <div className="stat-label">Vendors</div>
          <div className="stat-trend up">
            <TrendUpIcon />
            +5 this month
          </div>
        </div>
        <div className="proto-card stat-card" data-od-id="stat-estimates">
          <div className="stat-value num">{data.estimates}</div>
          <div className="stat-label">Estimates</div>
          <div className="stat-trend up">
            <TrendUpIcon />
            +3 this week
          </div>
        </div>
      </section>

      <section className="dashboard-grid" data-od-id="dashboard-grid">
        <article className="proto-card dashboard-panel" data-od-id="recent-activity">
          <header className="dashboard-panel-header">
            <h2>Recent Activity</h2>
            <Link href="/boqs" className="btn btn-ghost btn-sm" data-od-id="activity-view-all">
              View all
            </Link>
          </header>
          <div className="dashboard-activity-list">
            {data.boqs.length === 0 ? (
              <div className="proto-empty-state dashboard-panel-empty" data-od-id="activity-empty">
                <p>No activity yet.</p>
                <Link href="/boqs" className="btn btn-secondary btn-sm">Upload a BOQ</Link>
              </div>
            ) : (
              data.boqs.map((boq) => {
                return (
                  <div
                    key={boq.id}
                    className="dashboard-activity-item"
                    data-od-id={`activity-${boq.id}`}
                  >
                    <span className={`dashboard-activity-dot activity-${boq.workType.toLowerCase()}`} aria-hidden="true" />
                    <div className="dashboard-activity-content">
                      <div className="dashboard-activity-title">
                        BOQ uploaded — {boq.project}
                      </div>
                      <span className="meta dashboard-activity-meta">
                        {boq.workType} · {boq.vendor} · {timeAgo(boq.updatedAt)}
                      </span>
                    </div>
                    {/* ProtoBadge intentionally maps parsed to the neutral draft treatment. */}
                    <ProtoBadge status={boq.status} className="dashboard-activity-status" />
                  </div>
                );
              })
            )}
          </div>
        </article>

        <article className="proto-card dashboard-panel" data-od-id="quick-stats">
          <header className="dashboard-panel-header">
            <h2>Quick Stats</h2>
          </header>
          <div className="dashboard-quick-stats">
            <div className="dashboard-quick-stat">
              <div className="dashboard-quick-label">Total Items Across BOQs</div>
              <div className="dashboard-quick-value num">{totalItems}</div>
            </div>
            <div className="dashboard-quick-stat">
              <div className="dashboard-quick-label">Comparison Match Rate</div>
              <div className="dashboard-quick-row">
                <div className="dashboard-quick-value num">—</div>
                <span className="dashboard-quick-hint">Add BOQs to calculate</span>
              </div>
            </div>
            <div className="dashboard-quick-stat">
              <div className="dashboard-quick-label">Data Coverage</div>
              <div className="dashboard-quick-row">
                <div className="dashboard-quick-value num">—</div>
                <span className="dashboard-quick-hint">Standardize items to calculate</span>
              </div>
            </div>
          </div>
        </article>
      </section>
    </>
  );
}

function TrendUpIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="2 12 6 8 10 12 14 4" />
      <polyline points="9 4 14 4 14 9" />
    </svg>
  );
}

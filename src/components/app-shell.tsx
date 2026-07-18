import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({
  title,
  backHref,
  children,
}: {
  title?: string;
  backHref?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-area">
        <Topbar title={title} backHref={backHref} />
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}

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
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Topbar title={title} backHref={backHref} />
        <main className="flex-1 overflow-y-auto p-6 pb-12">{children}</main>
      </div>
    </div>
  );
}

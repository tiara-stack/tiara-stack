import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { isSheetEditorPath } from "#/routes";

// Route loader that fetches session on load using Atom Registry
export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardLayout,
});

function DashboardLayout() {
  const { pathname } = useLocation();
  const isSheetEditor = isSheetEditorPath(pathname);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={`min-h-screen min-w-0 text-white ${isSheetEditor ? "px-2 pb-20 pt-16 sm:px-4 sm:pb-24 sm:pt-28 lg:px-6" : "px-4 pb-12 pt-32 sm:px-8"}`}
    >
      <div className="mx-auto min-w-0 max-w-7xl">
        <Outlet />
      </div>
    </main>
  );
}

import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Bell, Calendar, Users, ChevronRight, type LucideIcon } from "lucide-react";

// Route loader that fetches session on load using Atom Registry
export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardLayout,
});

function DashboardLayout() {
  const { pathname } = useLocation();
  const activeTab = getActiveTab(pathname);

  return (
    <div className="min-h-screen text-white pt-32 pb-12 px-8">
      <div className="max-w-7xl mx-auto">
        {/* Compact Page Header */}
        <div className="flex items-center justify-between mb-8 border-b border-[#33ccbb]/20 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#33ccbb] flex items-center justify-center">
              <Calendar className="w-5 h-5 text-[#0a0f0e]" />
            </div>
            <div>
              <p className="text-[10px] font-bold tracking-[0.2em] text-[#33ccbb]">DASHBOARD</p>
              <h1 className="text-xl font-black tracking-tight">
                YOUR <span className="text-[#33ccbb]">SCHEDULE</span>
              </h1>
            </div>
          </div>
          <div className="hidden sm:block w-24 h-1 bg-[#33ccbb]/30" />
        </div>

        {/* Tab Navigation - Brutalist Style */}
        <div className="flex flex-col sm:flex-row gap-px bg-[#33ccbb]/20 mb-8">
          {tabs.map((tab) => (
            <DashboardTab key={tab.id} active={activeTab === tab.id} tab={tab} />
          ))}
        </div>

        {/* Page Content */}
        <Outlet />
      </div>
    </div>
  );
}

type DashboardTabId = "shifts" | "guilds" | "preferences";

type DashboardTabConfig = {
  id: DashboardTabId;
  icon: LucideIcon;
  label: string;
  to: "/dashboard/shifts" | "/dashboard/guilds" | "/dashboard/preferences";
};

const tabs: readonly DashboardTabConfig[] = [
  { id: "shifts", icon: Calendar, label: "MY SHIFTS", to: "/dashboard/shifts" },
  { id: "guilds", icon: Users, label: "GUILDS", to: "/dashboard/guilds" },
  { id: "preferences", icon: Bell, label: "PREFERENCES", to: "/dashboard/preferences" },
];

const getActiveTab = (pathname: string): DashboardTabId => {
  if (pathname.includes("/preferences")) {
    return "preferences";
  }
  if (pathname.includes("/guilds")) {
    return "guilds";
  }
  return "shifts";
};

function DashboardTab({ active, tab }: { active: boolean; tab: DashboardTabConfig }) {
  const Icon = tab.icon;
  const tabClassName = active
    ? "bg-[#33ccbb] text-[#0a0f0e]"
    : "bg-[#0f1615] text-white hover:bg-[#33ccbb]/10";
  const iconClassName = active ? "text-[#0a0f0e]" : "text-[#33ccbb]";
  const chevronClassName = active ? "rotate-90" : "group-hover:translate-x-1";

  return (
    <Link
      to={tab.to}
      className={`flex-1 flex items-center justify-between px-6 py-4 font-black text-sm tracking-wide transition-all duration-200 group ${tabClassName}`}
    >
      <div className="flex items-center gap-3">
        <Icon className={`w-4 h-4 ${iconClassName}`} />
        <span>{tab.label}</span>
      </div>
      <ChevronRight className={`w-4 h-4 transition-transform ${chevronClassName}`} />
    </Link>
  );
}

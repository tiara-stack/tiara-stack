import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Calendar, KeyRound, Users, ChevronRight } from "lucide-react";

// Route loader that fetches session on load using Atom Registry
export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardLayout,
});

function DashboardLayout() {
  const { pathname } = useLocation();
  const activeTab = pathname.includes("/oauth-clients")
    ? "oauth-clients"
    : pathname.includes("/guilds")
      ? "guilds"
      : "shifts";

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
          <Link
            to="/dashboard/shifts"
            className={`flex-1 flex items-center justify-between px-6 py-4 font-black text-sm tracking-wide transition-all duration-200 group ${
              activeTab === "shifts"
                ? "bg-[#33ccbb] text-[#0a0f0e]"
                : "bg-[#0f1615] text-white hover:bg-[#33ccbb]/10"
            }`}
          >
            <div className="flex items-center gap-3">
              <Calendar
                className={`w-4 h-4 ${
                  activeTab === "shifts" ? "text-[#0a0f0e]" : "text-[#33ccbb]"
                }`}
              />
              <span>MY SHIFTS</span>
            </div>
            <ChevronRight
              className={`w-4 h-4 transition-transform ${
                activeTab === "shifts" ? "rotate-90" : "group-hover:translate-x-1"
              }`}
            />
          </Link>

          <Link
            to="/dashboard/oauth-clients"
            className={`flex-1 flex items-center justify-between px-6 py-4 font-black text-sm tracking-wide transition-all duration-200 group ${
              activeTab === "oauth-clients"
                ? "bg-[#33ccbb] text-[#0a0f0e]"
                : "bg-[#0f1615] text-white hover:bg-[#33ccbb]/10"
            }`}
          >
            <div className="flex items-center gap-3">
              <KeyRound
                className={`w-4 h-4 ${
                  activeTab === "oauth-clients" ? "text-[#0a0f0e]" : "text-[#33ccbb]"
                }`}
              />
              <span>OAUTH CLIENTS</span>
            </div>
            <ChevronRight
              className={`w-4 h-4 transition-transform ${
                activeTab === "oauth-clients" ? "rotate-90" : "group-hover:translate-x-1"
              }`}
            />
          </Link>

          <Link
            to="/dashboard/guilds"
            className={`flex-1 flex items-center justify-between px-6 py-4 font-black text-sm tracking-wide transition-all duration-200 group ${
              activeTab === "guilds"
                ? "bg-[#33ccbb] text-[#0a0f0e]"
                : "bg-[#0f1615] text-white hover:bg-[#33ccbb]/10"
            }`}
          >
            <div className="flex items-center gap-3">
              <Users
                className={`w-4 h-4 ${
                  activeTab === "guilds" ? "text-[#0a0f0e]" : "text-[#33ccbb]"
                }`}
              />
              <span>GUILDS</span>
            </div>
            <ChevronRight
              className={`w-4 h-4 transition-transform ${
                activeTab === "guilds" ? "rotate-90" : "group-hover:translate-x-1"
              }`}
            />
          </Link>
        </div>

        {/* Page Content */}
        <Outlet />
      </div>
    </div>
  );
}

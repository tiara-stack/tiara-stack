import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CalendarDays,
  Users,
  Bell,
  ArrowRight,
  Server,
  LayoutDashboard,
  ChevronRight,
} from "lucide-react";
import { Button } from "#/components/ui/button";
import { useSignInWithDiscord } from "#/lib/auth";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

function LandingPage() {
  const signIn = useSignInWithDiscord();

  return (
    <div className="min-h-screen text-white relative overflow-x-hidden">
      <div className="relative">
        {/* Hero - Asymmetric Layout */}
        <section className="min-h-screen flex items-center pt-24">
          <div className="max-w-7xl mx-auto px-8 w-full">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
              {/* Left - Typography */}
              <div className="lg:col-span-7 relative">
                <div className="absolute -left-4 top-0 w-1 h-32 bg-[#33ccbb]" />

                <p className="text-sm font-bold tracking-[0.3em] text-[#33ccbb] mb-6 ml-4">
                  DISCORD SCHEDULE TOOL
                </p>

                <h1 className="text-6xl sm:text-7xl lg:text-8xl font-black leading-[0.9] tracking-tighter mb-8">
                  YOUR
                  <br />
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#33ccbb] to-[#2db8a8]">
                    SERVER
                  </span>
                  <br />
                  <span className="relative inline-block">
                    ORGANIZED
                    <svg
                      className="absolute -bottom-2 left-0 w-full"
                      viewBox="0 0 400 12"
                      fill="none"
                    >
                      <path
                        d="M2 8C100 2 300 2 398 8"
                        stroke="#33ccbb"
                        strokeWidth="4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                </h1>

                <p className="text-lg text-white/60 max-w-md mb-10 leading-relaxed">
                  Track filling and monitoring schedules. Know who&apos;s doing what, when.
                </p>

                <div className="flex flex-wrap items-center gap-4">
                  <Button
                    className="bg-[#33ccbb] hover:bg-[#2db8a8] text-[#0a0f0e] px-8 h-14 font-bold text-sm tracking-wide"
                    onClick={signIn}
                  >
                    CONNECT DISCORD
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                  <Button
                    variant="outline"
                    className="border-[#33ccbb]/30 bg-transparent text-white hover:bg-[#33ccbb]/10 px-8 h-14 font-bold text-sm tracking-wide"
                  >
                    VIEW DEMO
                  </Button>
                </div>
              </div>

              {/* Right - Stacked Cards */}
              <div className="lg:col-span-5 relative h-[500px] hidden lg:block">
                {/* Card 1 - Calendar */}
                <div className="absolute top-0 right-0 w-72 bg-[#0f1615] border border-[#33ccbb]/30 p-6 rotate-6 hover:rotate-0 hover:scale-105 hover:border-[#33ccbb] transition-all duration-500 shadow-2xl shadow-[#33ccbb]/10">
                  <CalendarDays className="w-10 h-10 text-[#33ccbb] mb-4" />
                  <p className="text-3xl font-black mb-2">UPCOMING</p>
                  <p className="text-sm font-medium text-white/50">12 slots this week</p>
                </div>

                {/* Card 2 - Users */}
                <div className="absolute top-32 right-20 w-72 bg-[#0f1615] border border-[#33ccbb]/30 p-6 -rotate-3 hover:rotate-0 hover:scale-105 hover:border-[#33ccbb] transition-all duration-500 shadow-xl">
                  <Users className="w-10 h-10 text-[#33ccbb] mb-4" />
                  <p className="text-3xl font-black mb-2">TEAM</p>
                  <p className="text-sm font-medium text-white/50">8 fillers active</p>
                </div>

                {/* Card 3 - Stats */}
                <div className="absolute top-64 right-8 w-72 bg-[#33ccbb] text-[#0a0f0e] p-6 rotate-2 hover:rotate-0 hover:scale-105 transition-all duration-500 shadow-2xl shadow-[#33ccbb]/30">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-4xl font-black">94%</span>
                    <ChevronRight className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-bold tracking-wide">COVERAGE RATE</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features - Broken Grid */}
        <section className="py-32 px-8">
          <div className="max-w-7xl mx-auto">
            {/* Section Header - Offset */}
            <div className="flex items-end justify-between mb-20">
              <div>
                <p className="text-sm font-bold tracking-[0.3em] text-[#33ccbb] mb-4">
                  WHAT IT DOES
                </p>
                <h2 className="text-5xl font-black tracking-tight">FEATURES</h2>
              </div>
              <div className="hidden md:block w-32 h-1 bg-[#33ccbb]/30" />
            </div>

            {/* Asymmetric Grid */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
              {/* Large Feature - Spans 7 cols */}
              <div className="md:col-span-7 bg-[#0f1615] border border-[#33ccbb]/20 p-10 relative group overflow-hidden hover:border-[#33ccbb]/40 transition-colors">
                <div className="absolute top-0 right-0 w-40 h-40 bg-[#33ccbb]/10 rounded-full blur-3xl group-hover:bg-[#33ccbb]/20 transition-colors" />
                <CalendarDays className="w-14 h-14 text-[#33ccbb] mb-6" />
                <h3 className="text-3xl font-black mb-4 tracking-tight">SCHEDULE VIEW</h3>
                <p className="text-lg text-white/60 max-w-sm leading-relaxed">
                  Clean calendar interface showing all upcoming slots. See what&apos;s available and
                  what&apos;s claimed at a glance.
                </p>
                <div className="absolute bottom-6 right-6 w-12 h-12 border-2 border-[#33ccbb]/30 flex items-center justify-center group-hover:bg-[#33ccbb] group-hover:border-[#33ccbb] transition-colors">
                  <ArrowRight className="w-5 h-5 group-hover:text-[#0a0f0e] transition-colors" />
                </div>
              </div>

              {/* Stack of 2 - Spans 5 cols */}
              <div className="md:col-span-5 flex flex-col gap-6">
                <div className="bg-[#0f1615] border border-[#33ccbb]/20 p-8 flex-1 group hover:border-[#33ccbb]/40 transition-colors">
                  <Bell className="w-10 h-10 text-[#33ccbb] mb-4" />
                  <h3 className="text-xl font-black mb-2">NOTIFICATIONS</h3>
                  <p className="text-white/50 text-sm">
                    Get reminded before your shifts via Discord
                  </p>
                </div>
                <div className="bg-[#33ccbb] text-[#0a0f0e] p-8 flex-1 group">
                  <Users className="w-10 h-10 mb-4" />
                  <h3 className="text-xl font-black mb-2">TEAM SYNC</h3>
                  <p className="text-[#0a0f0e]/70 text-sm font-medium">
                    Everyone sees what they need to see
                  </p>
                </div>
              </div>

              {/* Bottom Row */}
              <div className="md:col-span-5 bg-[#0f1615] border border-[#33ccbb]/20 p-8 group hover:border-[#33ccbb]/40 transition-colors">
                <div className="flex items-start justify-between">
                  <div>
                    <Server className="w-10 h-10 text-[#33ccbb] mb-4" />
                    <h3 className="text-xl font-black mb-2">SERVER OVERVIEW</h3>
                    <p className="text-white/50 text-sm max-w-xs">
                      Full visibility for monitors. Track all activity.
                    </p>
                  </div>
                  <div className="text-4xl font-black text-[#33ccbb]/20 group-hover:text-[#33ccbb]/40 transition-colors">
                    01
                  </div>
                </div>
              </div>

              <div className="md:col-span-7 bg-[#0f1615] border border-[#33ccbb]/20 p-8 flex items-center justify-between group hover:border-[#33ccbb]/40 transition-colors">
                <div>
                  <h3 className="text-2xl font-black mb-2">ROLE-BASED ACCESS</h3>
                  <p className="text-white/50">Fillers and monitors see different views</p>
                </div>
                <div className="w-16 h-16 border-2 border-dashed border-[#33ccbb]/30 rounded-full flex items-center justify-center group-hover:border-[#33ccbb] group-hover:rotate-180 transition-all duration-500">
                  <ArrowRight className="w-6 h-6 text-[#33ccbb]" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* For Who - Split Layout */}
        <section className="py-32 px-8">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center gap-4 mb-16">
              <div className="w-2 h-2 bg-[#33ccbb]" />
              <p className="text-sm font-bold tracking-[0.3em] text-[#33ccbb]">BUILT FOR</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-px bg-[#33ccbb]/20">
              {/* Fillers */}
              <div className="bg-[#0a0f0e] p-12 group hover:bg-[#0f1615] transition-colors">
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-16 h-16 bg-[#33ccbb] flex items-center justify-center">
                    <Users className="w-8 h-8 text-[#0a0f0e]" />
                  </div>
                  <h3 className="text-4xl font-black">FILLERS</h3>
                </div>

                <p className="text-white/60 mb-8 text-lg">
                  See what&apos;s open. Claim what you can cover.
                </p>

                <ul className="space-y-4">
                  {[
                    "Browse available slots",
                    "Claim with one click",
                    "Track your commitments",
                    "Get shift reminders",
                  ].map((item, i) => (
                    <li key={item} className="flex items-center gap-4 text-white/80">
                      <span className="text-[#33ccbb] font-black text-sm">0{i + 1}</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Monitors */}
              <div className="bg-[#0a0f0e] p-12 group hover:bg-[#0f1615] transition-colors">
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-16 h-16 bg-[#0f1615] border-2 border-[#33ccbb] flex items-center justify-center">
                    <Server className="w-8 h-8 text-[#33ccbb]" />
                  </div>
                  <h3 className="text-4xl font-black">MONITORS</h3>
                </div>

                <p className="text-white/60 mb-8 text-lg">
                  Full visibility. Spot gaps before they happen.
                </p>

                <ul className="space-y-4">
                  {[
                    "Full schedule overview",
                    "Track filler activity",
                    "Identify coverage gaps",
                    "Export reports",
                  ].map((item, i) => (
                    <li key={item} className="flex items-center gap-4 text-white/80">
                      <span className="text-[#33ccbb] font-black text-sm">0{i + 1}</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* CTA - Large Typography */}
        <section className="py-32 px-8 bg-[#33ccbb] relative overflow-hidden">
          <div className="absolute inset-0 opacity-10">
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `radial-gradient(circle at 2px 2px, #0a0f0e 1px, transparent 0)`,
                backgroundSize: "40px 40px",
              }}
            />
          </div>

          <div className="max-w-7xl mx-auto relative">
            <h2 className="text-5xl sm:text-7xl lg:text-8xl font-black tracking-tighter mb-8 text-[#0a0f0e]">
              READY?
            </h2>
            <p className="text-xl text-[#0a0f0e]/70 max-w-md mb-10">
              Connect your Discord and start managing your server&apos;s schedule.
            </p>
            <Button
              className="bg-[#0a0f0e] text-[#33ccbb] hover:bg-[#1a2422] px-10 h-16 font-black text-lg tracking-wide transition-colors"
              onClick={signIn}
            >
              GET STARTED
              <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-12 px-8 border-t border-[#33ccbb]/20">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#33ccbb] flex items-center justify-center">
                <LayoutDashboard className="w-5 h-5 text-[#0a0f0e]" />
              </div>
              <span className="text-xl font-black tracking-tight">
                SHEET<span className="text-[#33ccbb]">WEB</span>
              </span>
            </div>
            <div className="flex items-center gap-8">
              <Link
                to="/"
                className="text-sm font-bold text-white/50 hover:text-[#33ccbb] transition-colors tracking-wide"
              >
                PRIVACY
              </Link>
              <Link
                to="/"
                className="text-sm font-bold text-white/50 hover:text-[#33ccbb] transition-colors tracking-wide"
              >
                TERMS
              </Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

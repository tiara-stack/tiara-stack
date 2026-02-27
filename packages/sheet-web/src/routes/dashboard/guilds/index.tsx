import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";

export const Route = createFileRoute("/dashboard/guilds/")({
  component: GuildsIndexPage,
});

function GuildsIndexPage() {
  return (
    <div className="border border-[#33ccbb]/20 bg-[#0f1615] p-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-[#33ccbb]/10 flex items-center justify-center">
          <Users className="w-5 h-5 text-[#33ccbb]" />
        </div>
        <h2 className="text-xl font-black tracking-tight">YOUR GUILDS</h2>
      </div>
      <div className="h-48 flex items-center justify-center border-2 border-dashed border-[#33ccbb]/20">
        <p className="text-white/40 font-medium tracking-wide">SELECT A GUILD FROM THE SIDEBAR</p>
      </div>
    </div>
  );
}

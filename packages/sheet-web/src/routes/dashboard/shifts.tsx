import { createFileRoute } from "@tanstack/react-router";
import { Calendar } from "lucide-react";

export const Route = createFileRoute("/dashboard/shifts")({
  component: ShiftsPage,
});

function ShiftsPage() {
  return (
    <div className="border border-[#33ccbb]/20 bg-[#0f1615] p-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-[#33ccbb]/10 flex items-center justify-center">
          <Calendar className="w-5 h-5 text-[#33ccbb]" />
        </div>
        <h2 className="text-xl font-black tracking-tight">UPCOMING SHIFTS</h2>
      </div>
      <div className="h-48 flex items-center justify-center border-2 border-dashed border-[#33ccbb]/20">
        <p className="text-white/40 font-medium tracking-wide">NO UPCOMING SHIFTS</p>
      </div>
    </div>
  );
}

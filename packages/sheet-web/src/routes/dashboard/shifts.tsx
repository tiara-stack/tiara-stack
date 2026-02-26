import { createFileRoute } from "@tanstack/react-router";
import { Calendar } from "lucide-react";

export const Route = createFileRoute("/dashboard/shifts")({
  component: ShiftsPage,
});

function ShiftsPage() {
  return (
    <div className="border border-[#33ccbb]/20 bg-[#0f1615] p-12">
      <div className="flex items-center gap-4 mb-8">
        <div className="w-12 h-12 bg-[#33ccbb]/10 flex items-center justify-center">
          <Calendar className="w-6 h-6 text-[#33ccbb]" />
        </div>
        <h2 className="text-3xl font-black tracking-tight">UPCOMING SHIFTS</h2>
      </div>
      <div className="h-64 flex items-center justify-center border-2 border-dashed border-[#33ccbb]/20">
        <p className="text-white/40 font-medium tracking-wide">NO UPCOMING SHIFTS</p>
      </div>
    </div>
  );
}

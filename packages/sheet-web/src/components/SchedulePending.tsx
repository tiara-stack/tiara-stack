export function SchedulePending() {
  return (
    <section
      role="status"
      aria-live="polite"
      className="space-y-2 border border-[#33ccbb]/20 bg-[#0f1615] p-4 sm:p-6"
    >
      <p className="text-[10px] font-black tracking-[0.2em] text-[#33ccbb]">SCHEDULE</p>
      <p className="text-lg font-black tracking-tight text-white sm:text-xl">Loading schedule…</p>
    </section>
  );
}

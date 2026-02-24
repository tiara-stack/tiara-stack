import { Hexagon } from "lucide-react";

export function Background() {
  return (
    <>
      {/* Diagonal grid overlay */}
      <div
        className="fixed inset-0 pointer-events-none z-0 opacity-30"
        style={{
          background: `
            repeating-linear-gradient(
              45deg,
              transparent,
              transparent 60px,
              rgba(51, 204, 187, 0.03) 60px,
              rgba(51, 204, 187, 0.03) 62px
            )
          `,
        }}
      />

      {/* Floating hexagons */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <Hexagon className="absolute top-32 right-[10%] w-24 h-24 text-[#33ccbb]/10 rotate-12" />
        <Hexagon className="absolute bottom-40 left-[5%] w-32 h-32 text-[#33ccbb]/5 -rotate-6" />
      </div>
    </>
  );
}

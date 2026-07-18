import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { BookOpenText, LayoutDashboard } from "lucide-react";

export function docsLayoutOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-black tracking-tight">
          <span className="grid size-8 place-items-center bg-[#33ccbb] text-[#0a0f0e]">
            <BookOpenText className="size-4" />
          </span>
          TIARA<span className="text-[#33ccbb]">DOCS</span>
        </span>
      ),
      url: "/docs",
      transparentMode: "none",
    },
    links: [
      {
        type: "main",
        text: "Dashboard",
        url: "/dashboard/shifts",
        icon: <LayoutDashboard className="size-4" />,
      },
    ],
    themeSwitch: { enabled: false },
  };
}

import { Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Menu, X, LayoutDashboard, LogOut, User as UserIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { useSignOut, useSignInWithDiscord, useSession } from "#/lib/auth";
import { Option } from "effect";

function AuthSection() {
  const session = useSession();

  const signOut = useSignOut();
  const signIn = useSignInWithDiscord();

  return Option.match(session, {
    onSome: (session) => (
      <div className="flex items-center gap-4">
        <Link
          to="/dashboard"
          className="hidden sm:flex items-center gap-2 px-4 h-10 bg-[#33ccbb]/10 border border-[#33ccbb]/30 text-[#33ccbb] hover:bg-[#33ccbb]/20 font-bold text-sm tracking-wide transition-colors"
        >
          <LayoutDashboard className="w-4 h-4" />
          DASHBOARD
        </Link>
        <div className="flex items-center gap-3">
          {session.user.image ? (
            <img
              src={session.user.image}
              alt={session.user.name || "User"}
              className="w-10 h-10 rounded-full border-2 border-[#33ccbb] object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-[#33ccbb] flex items-center justify-center">
              <span className="text-[#0a0f0e] font-bold text-sm">
                {session.user.name?.charAt(0).toUpperCase() || "U"}
              </span>
            </div>
          )}
          <span className="text-sm font-medium text-white hidden md:inline">
            {session.user.name || "User"}
          </span>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="border-[#33ccbb]/30 text-[#33ccbb] hover:bg-[#33ccbb]/10 hover:text-white"
          onClick={signOut}
        >
          <LogOut className="w-4 h-4" />
        </Button>
      </div>
    ),
    onNone: () => (
      <Button
        className="bg-[#33ccbb] text-[#0a0f0e] hover:bg-[#2db8a8] px-6 h-12 font-bold text-sm tracking-wide transition-colors"
        onClick={signIn}
      >
        GET STARTED
      </Button>
    ),
  });
}

function MobileAuthSection({ onNavigate }: { onNavigate: () => void }) {
  const session = useSession();

  const signOut = useSignOut();
  const signIn = useSignInWithDiscord();

  return Option.match(session, {
    onSome: (session) => (
      <div className="pt-4 border-t border-[#33ccbb]/20 space-y-4">
        <div className="flex items-center gap-3 mb-4">
          {session.user.image ? (
            <img
              src={session.user.image}
              alt={session.user.name || "User"}
              className="w-12 h-12 rounded-full border-2 border-[#33ccbb] object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-[#33ccbb] flex items-center justify-center">
              <UserIcon className="w-6 h-6 text-[#0a0f0e]" />
            </div>
          )}
          <span className="text-lg font-bold text-white">{session.user.name || "User"}</span>
        </div>
        <Link
          to="/dashboard"
          onClick={onNavigate}
          className="flex items-center justify-center gap-2 w-full bg-[#33ccbb]/10 border border-[#33ccbb]/30 text-[#33ccbb] hover:bg-[#33ccbb]/20 h-14 font-bold text-lg tracking-wide transition-colors"
        >
          <LayoutDashboard className="w-5 h-5" />
          DASHBOARD
        </Link>
        <Button
          className="w-full bg-[#33ccbb]/10 border border-[#33ccbb]/30 text-[#33ccbb] hover:bg-[#33ccbb]/20 h-14 font-bold text-lg tracking-wide"
          onClick={signOut}
        >
          <LogOut className="w-5 h-5 mr-2" />
          SIGN OUT
        </Button>
      </div>
    ),
    onNone: () => (
      <Button
        className="w-full bg-[#33ccbb] hover:bg-[#2db8a8] text-[#0a0f0e] h-14 font-bold text-lg tracking-wide mt-4"
        onClick={signIn}
      >
        GET STARTED
      </Button>
    ),
  });
}

// Simple fallback for Header suspense - keeps layout stable during auth check
function HeaderFallback() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 px-8 py-6 bg-[#0a0f0e]/60 backdrop-blur-xl border-b border-[#33ccbb]/10">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-[#33ccbb] flex items-center justify-center">
            <span className="text-[#0a0f0e] font-black text-xl">S</span>
          </div>
          <span className="text-2xl font-black tracking-tighter">
            SHEET<span className="text-[#33ccbb]">WEB</span>
          </span>
        </div>
        <div className="w-24 h-10 bg-[#33ccbb]/10 animate-pulse rounded" />
      </div>
    </header>
  );
}

// Internal header component with auth-dependent content
function HeaderContent() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 px-8 py-6 bg-[#0a0f0e]/60 backdrop-blur-xl border-b border-[#33ccbb]/10">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3">
            <div className="w-12 h-12 bg-[#33ccbb] flex items-center justify-center hover:rotate-[360deg] transition-transform duration-700">
              <LayoutDashboard className="w-6 h-6 text-[#0a0f0e]" />
            </div>
            <span className="text-2xl font-black tracking-tighter">
              SHEET<span className="text-[#33ccbb]">WEB</span>
            </span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            <a
              href="#features"
              className="text-sm font-bold text-[#33ccbb] hover:text-white transition-colors tracking-wide"
            >
              FEATURES
            </a>
            <AuthSection />
          </nav>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsOpen(true)}
            className="md:hidden p-2 text-[#33ccbb] hover:text-white transition-colors"
            aria-label="Open menu"
          >
            <Menu size={24} />
          </button>
        </div>
      </header>

      {/* Mobile Sidebar */}
      <aside
        className={`fixed inset-0 z-50 md:hidden transition-opacity duration-200 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-[#0a0f0e]/95" onClick={() => setIsOpen(false)} />

        {/* Sidebar */}
        <div
          className={`absolute top-0 right-0 h-full w-80 bg-[#0a0f0e] border-l border-[#33ccbb]/20 transform transition-transform duration-300 ease-out ${
            isOpen ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between p-8 border-b border-[#33ccbb]/20">
            <span className="font-black text-xl tracking-tight text-[#33ccbb]">MENU</span>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 text-[#33ccbb] hover:text-white transition-colors"
              aria-label="Close menu"
            >
              <X size={24} />
            </button>
          </div>

          <nav className="p-8 space-y-6">
            <Link
              to="/"
              onClick={() => setIsOpen(false)}
              className="block text-2xl font-black text-white hover:text-[#33ccbb] transition-colors"
            >
              HOME
            </Link>
            <a
              href="#features"
              onClick={() => setIsOpen(false)}
              className="block text-2xl font-black text-white hover:text-[#33ccbb] transition-colors"
            >
              FEATURES
            </a>
            <MobileAuthSection onNavigate={() => setIsOpen(false)} />
          </nav>
        </div>
      </aside>
    </>
  );
}

// Exported Header component with Suspense boundary
export default function Header() {
  return (
    <Suspense fallback={<HeaderFallback />}>
      <HeaderContent />
    </Suspense>
  );
}

import { Suspense } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { isSheetEditorPath } from "#/routes";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  Server,
  Settings2,
  User as UserIcon,
  X,
} from "lucide-react";
import { Button } from "#/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "#/components/ui/avatar";
import { Skeleton } from "#/components/ui/skeleton";
import { useSignOut, useSignInWithSocialProvider, useSession } from "#/lib/auth";
import { useDismissOnOutsideOrEscape } from "#/lib/documentEvents";
import { Option } from "effect";

const desktopNavigationLinkClass =
  "inline-flex h-10 items-center gap-2 border-b-2 border-transparent px-1 text-sm font-bold tracking-wide text-[#33ccbb] transition-colors hover:border-[#33ccbb] hover:text-white [&.active]:border-[#33ccbb] [&.active]:text-white";

const mobileNavigationLinkClass =
  "flex items-center gap-3 text-2xl font-black text-white transition-colors hover:text-[#33ccbb]";

const mobileDialogFocusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const headerClassFor = (isSheetEditor: boolean) =>
  isSheetEditor
    ? "fixed top-0 left-0 right-0 z-50 border-b border-[#33ccbb]/10 bg-[#0a0f0e]/60 px-3 py-2 backdrop-blur-xl sm:px-8 sm:py-6"
    : "fixed top-0 left-0 right-0 z-50 border-b border-[#33ccbb]/10 bg-[#0a0f0e]/60 px-8 py-6 backdrop-blur-xl";

const logoBoxClassFor = (isSheetEditor: boolean) =>
  isSheetEditor
    ? "flex h-8 w-8 items-center justify-center bg-[#33ccbb] sm:h-12 sm:w-12"
    : "flex h-12 w-12 items-center justify-center bg-[#33ccbb]";

const logoIconClassFor = (isSheetEditor: boolean) =>
  isSheetEditor ? "h-4 w-4 text-[#0a0f0e] sm:h-6 sm:w-6" : "h-6 w-6 text-[#0a0f0e]";

const logoTitleClassFor = (isSheetEditor: boolean) =>
  isSheetEditor
    ? "text-lg font-black tracking-tighter sm:text-2xl"
    : "text-2xl font-black tracking-tighter";

const focusableElementsIn = (container: HTMLElement): Array<HTMLElement> =>
  Array.from(container.querySelectorAll<HTMLElement>(mobileDialogFocusableSelector)).filter(
    (element) => {
      const style = getComputedStyle(element);
      return (
        element.getAttribute("aria-hidden") !== "true" &&
        element.getClientRects().length > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    },
  );

const mobileDialogFocusEdgesFor = (
  focusable: ReadonlyArray<HTMLElement>,
  reverse: boolean,
): {
  readonly target: HTMLElement | undefined;
  readonly boundary: HTMLElement | undefined;
} => {
  const first = focusable.at(0);
  const last = focusable.at(-1);
  return reverse ? { target: last, boundary: first } : { target: first, boundary: last };
};

const mobileDialogFocusAtBoundary = (drawer: HTMLElement, boundary: HTMLElement): boolean =>
  !drawer.contains(document.activeElement) || document.activeElement === boundary;

const mobileDialogFocusTargetFor = (
  focusable: ReadonlyArray<HTMLElement>,
  drawer: HTMLElement,
  reverse: boolean,
): HTMLElement | undefined => {
  const { target: focusTarget, boundary } = mobileDialogFocusEdgesFor(focusable, reverse);
  if (focusTarget === undefined) return undefined;
  if (boundary === undefined) return undefined;
  if (!mobileDialogFocusAtBoundary(drawer, boundary)) return undefined;
  return focusTarget;
};

const wrapMobileDialogFocus = (event: KeyboardEvent, drawer: HTMLElement) => {
  const focusable = focusableElementsIn(drawer);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const focusTarget = mobileDialogFocusTargetFor(focusable, drawer, event.shiftKey);
  if (focusTarget === undefined) return;
  event.preventDefault();
  focusTarget.focus();
};

function AuthSection() {
  const session = useSession();

  const signOut = useSignOut();
  const signInWithDiscord = useSignInWithSocialProvider("discord");

  return Option.match(session, {
    // fallow-ignore-next-line complexity
    onSome: (session) => (
      <div className="flex items-center gap-4">
        <Link to="/dashboard/guilds" className={desktopNavigationLinkClass} aria-label="Servers">
          <Server className="w-4 h-4" />
          SERVERS
        </Link>
        <AccountMenu
          displayName={session.user.name || "User"}
          image={session.user.image}
          onSignOut={signOut}
        />
      </div>
    ),
    onNone: () => (
      <Button
        className="bg-[#33ccbb] text-[#0a0f0e] hover:bg-[#2db8a8] px-6 h-12 font-bold text-sm tracking-wide transition-colors"
        onClick={signInWithDiscord}
      >
        GET STARTED
      </Button>
    ),
  });
}

function AccountMenu({
  displayName,
  image,
  onSignOut,
}: {
  readonly displayName: string;
  readonly image: string | null | undefined;
  readonly onSignOut: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setIsOpen(false), []);

  useDismissOnOutsideOrEscape(isOpen, menuRef, triggerRef, closeMenu);

  return (
    <div ref={menuRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="flex items-center gap-2 rounded-full text-white transition-colors hover:text-[#33ccbb] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#73e9dc]"
        aria-controls="account-menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <Avatar size="lg" className="border-2 border-[#33ccbb]">
          {image ? <AvatarImage src={image} alt={displayName} /> : null}
          <AvatarFallback delay={0} className="relative bg-[#33ccbb] text-[#0a0f0e]">
            {image && (
              <Skeleton className="absolute inset-0 size-full rounded-full bg-[#33ccbb]/50" />
            )}
            <span className="relative z-10 text-sm font-bold">
              {displayName.charAt(0).toUpperCase() || "U"}
            </span>
          </AvatarFallback>
        </Avatar>
        <span className="hidden max-w-40 truncate text-sm font-medium md:inline">
          {displayName}
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen ? (
        <div
          id="account-menu"
          className="absolute right-0 top-full z-50 mt-3 min-w-52 border border-[#33ccbb]/25 bg-[#0f1615] p-2 shadow-xl"
        >
          <Link
            to="/settings/notifications"
            className="flex items-center gap-3 px-3 py-3 text-sm font-bold tracking-wide text-white transition-colors hover:bg-[#33ccbb]/10 hover:text-[#33ccbb] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc]"
            onClick={() => setIsOpen(false)}
          >
            <Settings2 className="h-4 w-4 text-[#33ccbb]" />
            MY PREFERENCES
          </Link>
          <button
            type="button"
            className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm font-bold tracking-wide text-white transition-colors hover:bg-[#ff4444]/10 hover:text-[#ff8a80] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#73e9dc]"
            onClick={onSignOut}
          >
            <LogOut className="h-4 w-4" />
            SIGN OUT
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MobileAuthSection({ onNavigate }: { onNavigate: () => void }) {
  const session = useSession();

  const signOut = useSignOut();
  const signInWithDiscord = useSignInWithSocialProvider("discord");

  return Option.match(session, {
    // fallow-ignore-next-line complexity
    onSome: (session) => (
      <div className="pt-4 border-t border-[#33ccbb]/20 space-y-4">
        <div className="flex items-center gap-3 mb-4">
          <Avatar className="size-12 border-2 border-[#33ccbb]">
            {session.user.image ? (
              <AvatarImage src={session.user.image} alt={session.user.name || "User"} />
            ) : null}
            <AvatarFallback delay={0} className="relative bg-[#33ccbb] text-[#0a0f0e]">
              {session.user.image && (
                <Skeleton className="absolute inset-0 size-full rounded-full bg-[#33ccbb]/50" />
              )}
              <UserIcon className="w-6 h-6 relative z-10" />
            </AvatarFallback>
          </Avatar>
          <span className="text-lg font-bold text-white">{session.user.name || "User"}</span>
        </div>
        <Link to="/dashboard/guilds" onClick={onNavigate} className={mobileNavigationLinkClass}>
          <Server className="w-5 h-5" />
          SERVERS
        </Link>
        <Link
          to="/settings/notifications"
          onClick={onNavigate}
          className={mobileNavigationLinkClass}
        >
          <Settings2 className="w-5 h-5" />
          MY PREFERENCES
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
        onClick={signInWithDiscord}
      >
        GET STARTED
      </Button>
    ),
  });
}

// Simple fallback for Header suspense - keeps layout stable during auth check
function HeaderFallback() {
  const { pathname } = useLocation();
  const isSheetEditor = isSheetEditorPath(pathname);
  return (
    <header className={headerClassFor(isSheetEditor)}>
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={logoBoxClassFor(isSheetEditor)}>
            <span className="text-[#0a0f0e] font-black text-xl">S</span>
          </div>
          <span className={logoTitleClassFor(isSheetEditor)}>
            SHEET<span className="text-[#33ccbb]">WEB</span>
          </span>
        </div>
        <div className="flex items-center gap-8">
          <Link to="/docs/$" params={{ _splat: "" }} className={desktopNavigationLinkClass}>
            DOCS
          </Link>
          <div className="w-24 h-10 bg-[#33ccbb]/10 animate-pulse rounded" />
        </div>
      </div>
    </header>
  );
}

// Internal header component with auth-dependent content
// fallow-ignore-next-line complexity
function HeaderContent() {
  const { pathname } = useLocation();
  const isSheetEditor = isSheetEditorPath(pathname);
  const [isOpen, setIsOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      closeButtonRef.current?.focus();
    } else if (wasOpenRef.current) {
      menuTriggerRef.current?.focus();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    const breakpoint = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setIsOpen(false);
    };
    if (breakpoint.matches) setIsOpen(false);
    breakpoint.addEventListener("change", closeOnDesktop);
    return () => breakpoint.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const drawer = drawerRef.current;
      if (drawer === null) return;
      wrapMobileDialogFocus(event, drawer);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const drawer = drawerRef.current;
    if (drawer === null) return;

    const changed: Array<readonly [HTMLElement, boolean]> = [];
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const isolateOutsideDrawer = (element: Element) => {
      if (element === drawer) return;
      if (element.contains(drawer)) {
        for (const child of Array.from(element.children)) isolateOutsideDrawer(child);
        return;
      }
      if (!(element instanceof HTMLElement)) return;
      changed.push([element, element.inert]);
      element.inert = true;
    };

    for (const child of Array.from(document.body.children)) isolateOutsideDrawer(child);
    return () => {
      document.body.style.overflow = previousOverflow;
      for (const [element, wasInert] of changed) element.inert = wasInert;
    };
  }, [isOpen]);

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:bg-[#33ccbb] focus:px-4 focus:py-3 focus:text-sm focus:font-black focus:text-[#0a0f0e] focus:outline-2 focus:outline-offset-2 focus:outline-[#73e9dc]"
      >
        SKIP TO MAIN CONTENT
      </a>
      <header className={headerClassFor(isSheetEditor)}>
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3">
            <div
              className={`${logoBoxClassFor(isSheetEditor)} transition-transform duration-700 hover:rotate-[360deg]`}
            >
              <LayoutDashboard className={logoIconClassFor(isSheetEditor)} />
            </div>
            <span className={logoTitleClassFor(isSheetEditor)}>
              SHEET<span className="text-[#33ccbb]">WEB</span>
            </span>
          </Link>

          {/* Desktop Navigation */}
          <nav aria-label="Global navigation" className="hidden items-center gap-8 md:flex">
            <Link to="/docs/$" params={{ _splat: "" }} className={desktopNavigationLinkClass}>
              DOCS
            </Link>
            <AuthSection />
          </nav>

          {/* Mobile Menu Button */}
          <button
            ref={menuTriggerRef}
            onClick={() => setIsOpen(true)}
            className="md:hidden p-2 text-[#33ccbb] hover:text-white transition-colors"
            aria-label="Open menu"
            aria-controls="mobile-navigation-drawer"
            aria-expanded={isOpen}
          >
            <Menu size={24} />
          </button>
        </div>
      </header>

      {/* Mobile Sidebar */}
      <aside
        ref={drawerRef}
        id="mobile-navigation-drawer"
        className={`fixed inset-0 z-50 overflow-x-clip md:hidden transition-opacity duration-200 ${
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-navigation-title"
        aria-hidden={!isOpen}
        inert={!isOpen}
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
            <span
              id="mobile-navigation-title"
              className="font-black text-xl tracking-tight text-[#33ccbb]"
            >
              MENU
            </span>
            <button
              ref={closeButtonRef}
              onClick={() => setIsOpen(false)}
              className="p-2 text-[#33ccbb] hover:text-white transition-colors"
              aria-label="Close menu"
            >
              <X size={24} />
            </button>
          </div>

          <nav aria-label="Mobile navigation" className="space-y-6 p-8">
            <Link
              to="/"
              onClick={() => setIsOpen(false)}
              className="block text-2xl font-black text-white hover:text-[#33ccbb] transition-colors"
            >
              HOME
            </Link>
            <Link
              to="/docs/$"
              params={{ _splat: "" }}
              onClick={() => setIsOpen(false)}
              className={mobileNavigationLinkClass}
            >
              DOCS
            </Link>
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

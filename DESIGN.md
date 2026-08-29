---
name: SheetWeb
description: Dark futuristic control surfaces for Discord schedule management.
colors:
  deep-green-black: "#0a0f0e"
  deep-teal-wash: "#0f1615"
  docs-deep-teal-wash: "#0f1816"
  muted-teal-surface: "#111b19"
  secondary-teal-surface: "#14201e"
  field-green-black: "#09110f"
  electric-teal: "#33ccbb"
  deep-electric-teal: "#2db8a8"
  soft-electric-teal: "#5be0d1"
  white: "#ffffff"
  soft-white: "#f5fffd"
  muted-aqua-gray: "#8ba8a3"
  teal-white: "#d8f7f2"
  teal-border: "rgba(51, 204, 187, 0.2)"
  teal-border-subtle: "rgba(51, 204, 187, 0.1)"
  teal-wash: "rgba(51, 204, 187, 0.12)"
  control-overlay: "rgba(10, 15, 14, 0.6)"
  danger-red: "#ff4444"
  warning-amber: "#ffb86b"
  error-coral: "#ff6b6b"
  scrollbar-green: "#1a2624"
typography:
  display:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "96px"
    fontWeight: 900
    lineHeight: "0.9"
    letterSpacing: "-0.05em"
  headline:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "48px"
    fontWeight: 900
    lineHeight: "1"
    letterSpacing: "-0.025em"
  title:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "20px"
    fontWeight: 900
    lineHeight: "1.2"
    letterSpacing: "-0.025em"
  body:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "1.5"
  label:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    fontSize: "10px"
    fontWeight: 700
    lineHeight: "1.2"
    letterSpacing: "0.2em"
rounded:
  none: "0px"
  guild-icon: "8px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "128px"
components:
  button-primary:
    backgroundColor: "{colors.electric-teal}"
    textColor: "{colors.deep-green-black}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm} {spacing.lg}"
    height: "48px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.white}"
    rounded: "{rounded.none}"
    padding: "{spacing.sm} {spacing.lg}"
    height: "48px"
  card-surface:
    backgroundColor: "{colors.deep-teal-wash}"
    textColor: "{colors.white}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg}"
  field:
    backgroundColor: "{colors.field-green-black}"
    textColor: "{colors.white}"
    rounded: "{rounded.none}"
    padding: "8px 16px"
    height: "48px"
  navigation:
    backgroundColor: "{colors.control-overlay}"
    textColor: "{colors.white}"
    rounded: "{rounded.none}"
    padding: "{spacing.lg} {spacing.xl}"
    height: "97px"
---

# Design System: SheetWeb

## Overview

**Creative North Star: "The Dark Futuristic Control Theme"**

SheetWeb treats the interface like a compact control room for a live Discord
shift. A green-black canvas carries a bright electric teal signal. Large,
heavy Inter headlines, square control surfaces, thin borders, and small
uppercase labels make state and action easy to spot.

The system is high contrast and operational, with a little visual voltage. The
landing page uses diagonal grid texture, floating hexagons, tilted cards, teal
glow, and short hover transitions. Authenticated screens keep the same language
in a denser layout, with split panels, schedule grids, and clear role-based
navigation.

**Key Characteristics:**

- Dark green-black canvas with an electric teal signal.
- Heavy Inter hierarchy with uppercase, letter-spaced labels.
- Square surfaces and thin translucent teal rules.
- Tonal layering first, selective glow and motion for emphasis.
- Asymmetric landing compositions and dense operational dashboards.

## Colors

The palette is near-black and green-tinted, with electric teal used as the
active signal. Deep teal wash is the low-intensity background expression of
electric teal, not a second accent.

### Primary

- **Electric Teal** (`#33ccbb`): Primary actions, active tabs, selected states,
  system labels, icon strokes, focus rings, and the main landing-page accent.
- **Deep Electric Teal** (`#2db8a8`): Darker action hover state.
- **Soft Electric Teal** (`#5be0d1`): Light accent text in docs and other
  secondary emphasis.

### Neutral

- **Deep Green-Black** (`#0a0f0e`): Main canvas, page background, and text on
  electric teal.
- **Deep Teal Wash** (`#0f1615`): Primary panel and card background. It is the
  muted background expression of electric teal.
- **Docs Deep Teal Wash** (`#0f1816`): Docs-specific card and popover surface.
- **Muted Teal Surface** (`#111b19`): Docs muted surface.
- **Secondary Teal Surface** (`#14201e`): Docs secondary surface.
- **Field Green-Black** (`#09110f`): Text field and select background.
- **White** (`#ffffff`): Main foreground text.
- **Soft White** (`#f5fffd`): Docs foreground and softened high-contrast text.
- **Muted Aqua Gray** (`#8ba8a3`): Secondary docs text.
- **Teal White** (`#d8f7f2`): Docs secondary foreground.
- **Teal Border** (`rgba(51, 204, 187, 0.2)`): Standard panel and divider
  border.
- **Teal Border Subtle** (`rgba(51, 204, 187, 0.1)`): Header and low-emphasis
  divider border.
- **Teal Wash** (`rgba(51, 204, 187, 0.12)`): Selected and hover surface wash.
- **Control Overlay** (`rgba(10, 15, 14, 0.6)`): Translucent fixed header
  background.

### Status

- **Danger Red** (`#ff4444`): Destructive states and destructive controls.
- **Warning Amber** (`#ffb86b`): Configuration warnings and caution states.
- **Error Coral** (`#ff6b6b`): Root error heading and high-attention error
  copy.

**The Signal Rule.** Use electric teal for actions, active states, system
labels, and key status. Let the green-black field carry most of the screen.

**The Wash Rule.** Treat deep teal wash as a background layer. It supports the
signal instead of competing with it.

## Typography

**Display Font:** Inter (with system sans-serif fallbacks)
**Body Font:** Inter (with system sans-serif fallbacks)
**Label/Mono Font:** Inter for labels; the platform monospace stack for IDs and
raw values.

**Character:** The type system is heavy, direct, and easy to scan. Large
headlines carry the landing page, while compact uppercase labels make system
state and navigation read like control-room annotations.

### Hierarchy

- **Display** (900, 96px, 0.9 line-height, -0.05em): Landing hero headline at
  large desktop sizes.
- **Headline** (900, 48px, 1 line-height, tight tracking): Landing section
  headings and major page statements.
- **Title** (900, 20px, 1.2 line-height, tight tracking): Dashboard and panel
  titles.
- **Body** (400, 16px, 1.5 line-height): Explanatory copy and standard page
  text.
- **Label** (700, 10px, 0.2em tracking, uppercase): Section markers,
  dashboard context labels, status labels, and compact metadata. Larger 14px
  uppercase labels are used for primary controls and navigation.

**The Weight Rule.** Reserve the heaviest weights for hierarchy and action.
Use regular body text for explanation instead of making every line compete.

## Layout

The system uses a 1280px maximum content container with 32px horizontal
padding on desktop. The landing page begins with a full-height hero and a
12-column asymmetric grid at the large breakpoint. Its text occupies seven
columns while a stacked card group occupies five. The stacked cards disappear
below the large breakpoint rather than compressing into a crowded mobile
composition.

Landing sections use 128px vertical padding and 32px horizontal padding. The
features region uses a 12-column broken grid at medium sizes, with 24px gaps
and deliberately uneven spans. The built-for region becomes two columns at
large sizes and one column on smaller screens.

Authenticated screens keep the same 1280px container but use denser layouts.
The dashboard starts 128px below the top of the page, uses a compact bordered
header, and places tabs in a one-pixel-separated control row. Guild views use a
small vertical guild rail beside the main content. Calendar views use a
seven-column day grid with thin rules and 56px day cells.

The fixed header is 97px tall at the observed desktop size. It uses 32px
horizontal padding, a 24px vertical rhythm, and a translucent backdrop. Mobile
navigation becomes a right-side 320px drawer. Landing sections stack into one
column, while dashboard split panels collapse to one column.

Spacing follows the Tailwind 4px scale. The recurring values are 8px, 16px,
24px, 32px, and the 128px section rhythm.

## Elevation & Depth

The system is flat by default and creates depth with tonal layering. The main
canvas is deep green-black, panels use deep teal wash, and thin teal borders
separate regions. Standard headers, controls, and dashboard surfaces do not
depend on shadows. The landing page uses `shadow-xl` and `shadow-2xl` on its
tilted feature cards, sometimes with a teal glow, to create a stronger focal
point. Hover rotation, scale, and border changes reinforce that emphasis.

**The Flat Surface Rule.** Keep operational surfaces flat and legible. Use
shadow, glow, rotation, or scale only when a featured element needs extra
attention or when a state change needs a clear response.

## Shapes

The default silhouette is square. Global radius tokens are zero, so buttons,
cards, panels, tabs, and fields use sharp corners. Borders are usually one pixel
and teal with reduced opacity. Dashed circular outlines appear as occasional
decorative or interactive accents, while avatars remain circular. Guild icons
use a small 8px radius when they need a compact image shape.

## Components

### Buttons

- **Shape:** Square by default (`0px` radius).
- **Primary:** Electric teal background, deep green-black text, bold Inter,
  uppercase, and 48px minimum height. Landing CTAs expand to 56px or 64px and
  use larger horizontal padding.
- **Hover / Focus:** Primary actions darken to deep electric teal. Focus uses a
  2px electric teal outline with a 4px offset. The global active state shifts
  controls down by 2px.
- **Secondary / Ghost / Tertiary:** Transparent or deep teal wash background,
  white or electric teal text, and a translucent teal border. Keep the outline
  quiet next to the filled primary action.

### Cards / Containers

- **Character:** Quiet control surfaces with visible structure.
- **Corner Style:** Square (`0px`).
- **Background:** Deep teal wash on the main app; docs may use docs deep teal
  wash, muted teal surface, or secondary teal surface.
- **Shadow Strategy:** Flat at rest. Refer to Elevation & Depth for the
  landing-card exception.
- **Border:** One-pixel teal border at 20% opacity, with 10% opacity for low
  emphasis.
- **Internal Padding:** 24px is the common panel padding. Landing compositions
  also use 32px, 40px, and 48px.

### Inputs / Fields

- **Style:** Deep green-black field background, one-pixel teal border, square
  corners, 8px vertical and 16px horizontal padding, and monospace text for raw
  identifiers or client values.
- **Focus:** Border changes to electric teal. Preserve the sharp focus outline
  and keep the field readable against the deep canvas.
- **Error / Disabled:** Use danger red or error coral for validation copy and
  subdued white with reduced opacity for disabled controls.

### Navigation

- **Style:** Fixed, translucent deep green-black header with a blurred backdrop
  and a subtle teal bottom border.
- **Typography:** Bold uppercase or tracked Inter labels in electric teal.
  Hover adds a teal bottom border and shifts the label toward white.
- **Active:** Use filled electric teal for dashboard tabs and deep green-black
  text. Keep active state unmistakable.
- **Mobile:** Replace the desktop nav with a right-side dark drawer, a teal
  divider, large white links, and a clear close control.

### Schedule Grid

- **Structure:** Seven equal day columns separated by fine teal rules.
- **State:** Use a low-opacity teal wash for the selected day and electric teal
  for navigation controls and key markers.
- **Behavior:** Keep date movement readable with short sliding transitions. Do
  not add decorative motion to every cell.

## Do's and Don'ts

### Do:

- **Do** keep the main canvas deep green-black and use deep teal wash for the
  background of standard panels.
- **Do** use electric teal as the primary signal for actions, active states,
  labels, and focus.
- **Do** use square corners for controls and panels, reserving full rounding for
  avatars and small image treatments.
- **Do** use heavy Inter for hierarchy and tracked uppercase labels for system
  context.
- **Do** use thin rules, grid structure, and tonal contrast to make operational
  state scannable.
- **Do** keep motion short and purposeful, especially on high-frequency
  dashboard controls.

### Don't:

- **Don't** introduce rounded cards, pill-shaped controls, or soft SaaS styling
  as the default language.
- **Don't** replace the deep green-black and electric teal world with a light
  canvas or a new primary accent without an explicit redesign decision.
- **Don't** put heavy shadows on every surface. Reserve them for landing-page
  emphasis and clear elevation states.
- **Don't** make every label, paragraph, and icon equally loud. Preserve the
  display, title, body, and metadata hierarchy.
- **Don't** use rotation, glow, or scale on controls that people need to scan
  repeatedly during a live shift.

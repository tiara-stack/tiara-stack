import type {
  SheetActionButton,
  SheetMessageActionRow,
  SheetMessageEmbed,
  SheetOutboundMessage,
  SheetText,
  SheetTextPart,
} from "sheet-ingress-api/schemas/client";

type Labels = {
  readonly users?: Readonly<Record<string, string>>;
  readonly conversations?: Readonly<Record<string, string>>;
  readonly roles?: Readonly<Record<string, string>>;
};

type DiscordCommandInvocation = {
  readonly name: string;
  readonly userName?: string;
};

const terms = {
  workspace: ["workspace", "workspaces"],
  conversation: ["conversation", "conversations"],
  runDestination: ["run destination", "run destinations"],
  checkinDestination: ["check-in destination", "check-in destinations"],
  monitorRole: ["monitor role", "monitor roles"],
  message: ["message", "messages"],
  testRun: ["test run", "test runs"],
} as const;

const sentenceCase = (value: string) => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;

type TextPartOf<Type extends SheetTextPart["type"]> = Extract<SheetTextPart, { type: Type }>;

type TimestampStyle = TextPartOf<"timestamp">["style"];
type AbsoluteTimestampStyle = Exclude<NonNullable<TimestampStyle>, "relative">;

const timestampOptions = {
  default: {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  shortTime: { hour: "numeric", minute: "2-digit" },
  longTime: { hour: "numeric", minute: "2-digit", second: "2-digit" },
  shortDate: { year: "numeric", month: "2-digit", day: "2-digit" },
  longDate: { year: "numeric", month: "long", day: "numeric" },
} satisfies Record<AbsoluteTimestampStyle | "default", Intl.DateTimeFormatOptions>;

const formatRelativeTimestamp = (epochMs: number, referenceEpochMs: number) => {
  const differenceMs = epochMs - referenceEpochMs;
  const absoluteDifferenceMs = Math.abs(differenceMs);
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absoluteDifferenceMs >= 86_400_000
      ? [86_400_000, "day"]
      : absoluteDifferenceMs >= 3_600_000
        ? [3_600_000, "hour"]
        : absoluteDifferenceMs >= 60_000
          ? [60_000, "minute"]
          : [1_000, "second"];
  return new Intl.RelativeTimeFormat("en-US", { numeric: "always" }).format(
    Math.sign(differenceMs) * Math.round(absoluteDifferenceMs / divisor),
    unit,
  );
};

const formatTimestamp = (epochMs: number, style: TimestampStyle, referenceEpochMs: number) =>
  style === "relative"
    ? formatRelativeTimestamp(epochMs, referenceEpochMs)
    : new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        ...timestampOptions[style ?? "default"],
      }).format(new Date(epochMs));

const SheetTextPartView = ({
  part,
  labels,
  referenceEpochMs,
}: {
  part: SheetTextPart;
  labels: Labels;
  referenceEpochMs: number;
}) => {
  const views = {
    text: ({ text }: TextPartOf<"text">) => text,
    userMention: ({ userId }: TextPartOf<"userMention">) => (
      <span className="rounded-sm bg-[#3c4270] px-0.5 font-medium text-[#c9cdfb]">
        @{labels.users?.[userId] ?? userId}
      </span>
    ),
    conversationMention: ({ conversation }: TextPartOf<"conversationMention">) => (
      <span className="rounded-sm bg-[#3c4270] px-0.5 font-medium text-[#c9cdfb]">
        #{labels.conversations?.[conversation.conversationId] ?? conversation.conversationId}
      </span>
    ),
    roleMention: ({ roleId }: TextPartOf<"roleMention">) => (
      <span className="rounded-sm bg-[#3c4270] px-0.5 font-medium text-[#c9cdfb]">
        @{labels.roles?.[roleId] ?? roleId}
      </span>
    ),
    messageLink: ({ label }: TextPartOf<"messageLink">) => (
      <span className="font-medium text-[#00a8fc] underline">{label ?? "message"}</span>
    ),
    timestamp: ({ epochMs, style }: TextPartOf<"timestamp">) => (
      <span className="rounded-sm bg-[#2b2d31] px-1 text-[#dbdee1]">
        {formatTimestamp(epochMs, style, referenceEpochMs)}
      </span>
    ),
    strong: ({ parts }: TextPartOf<"strong">) => (
      <strong>
        <SheetTextView value={parts} labels={labels} referenceEpochMs={referenceEpochMs} />
      </strong>
    ),
    inlineCode: ({ text }: TextPartOf<"inlineCode">) => (
      <code className="rounded bg-[#1e1f22] px-1 py-0.5 text-[0.9em]">{text}</code>
    ),
    strikethrough: ({ parts }: TextPartOf<"strikethrough">) => (
      <s>
        <SheetTextView value={parts} labels={labels} referenceEpochMs={referenceEpochMs} />
      </s>
    ),
    subtle: ({ parts }: TextPartOf<"subtle">) => (
      <span className="text-[#949ba4]">
        <SheetTextView value={parts} labels={labels} referenceEpochMs={referenceEpochMs} />
      </span>
    ),
    externalLink: ({ url, label }: TextPartOf<"externalLink">) => (
      <a href={url} className="font-medium text-[#00a8fc] underline" rel="noreferrer">
        {label ?? url}
      </a>
    ),
    clientTerm: ({ term, form, casing }: TextPartOf<"clientTerm">) => {
      const value = terms[term][form === "plural" ? 1 : 0];
      return casing === "sentence" ? sentenceCase(value) : value;
    },
  } satisfies {
    readonly [Type in SheetTextPart["type"]]: (part: TextPartOf<Type>) => React.ReactNode;
  };
  return views[part.type](part as never);
};

const SheetTextView = ({
  value,
  labels = {},
  referenceEpochMs,
}: {
  value: SheetText;
  labels?: Labels;
  referenceEpochMs: number;
}) =>
  typeof value === "string"
    ? value
    : value.map((part, index) => (
        <SheetTextPartView
          key={index}
          part={part}
          labels={labels}
          referenceEpochMs={referenceEpochMs}
        />
      ));

type SheetEmbedPartProps = {
  readonly embed: SheetMessageEmbed;
  readonly labels: Labels;
  readonly referenceEpochMs: number;
};

const SheetEmbedTitle = ({ embed, labels, referenceEpochMs }: SheetEmbedPartProps) =>
  embed.title === undefined ? null : (
    <div className="font-semibold text-white">
      <SheetTextView value={embed.title} labels={labels} referenceEpochMs={referenceEpochMs} />
    </div>
  );

const SheetEmbedDescription = ({ embed, labels, referenceEpochMs }: SheetEmbedPartProps) =>
  embed.description == null ? null : (
    <div className="whitespace-pre-wrap text-[#dbdee1]">
      <SheetTextView
        value={embed.description}
        labels={labels}
        referenceEpochMs={referenceEpochMs}
      />
    </div>
  );

const SheetEmbedFields = ({ embed, labels, referenceEpochMs }: SheetEmbedPartProps) =>
  embed.fields?.length ? (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {embed.fields.map((field, index) => (
        <div key={index} className={field.inline ? "" : "sm:col-span-2"}>
          <div className="mb-0.5 font-semibold text-white">
            <SheetTextView value={field.name} labels={labels} referenceEpochMs={referenceEpochMs} />
          </div>
          <div className="whitespace-pre-wrap text-[#dbdee1]">
            <SheetTextView
              value={field.value}
              labels={labels}
              referenceEpochMs={referenceEpochMs}
            />
          </div>
        </div>
      ))}
    </div>
  ) : null;

const SheetEmbedFooter = ({ embed, labels, referenceEpochMs }: SheetEmbedPartProps) =>
  embed.footer === undefined ? null : (
    <div className="pt-1 text-xs font-medium text-[#b5bac1]">
      <SheetTextView
        value={embed.footer.text}
        labels={labels}
        referenceEpochMs={referenceEpochMs}
      />
    </div>
  );

const embedAccent = (color: number | undefined) =>
  color === undefined ? "#4e5058" : `#${color.toString(16).padStart(6, "0")}`;

const SheetEmbed = ({ embed, labels, referenceEpochMs }: SheetEmbedPartProps) => (
  <div className="relative mt-2 grid max-w-[520px] overflow-hidden rounded-[4px] bg-[#2b2d31] shadow-sm">
    <span
      aria-hidden="true"
      className="absolute inset-y-0 left-0 w-1"
      style={{ backgroundColor: embedAccent(embed.color) }}
    />
    <div className="space-y-2.5 px-4 py-3 pl-5">
      <SheetEmbedTitle embed={embed} labels={labels} referenceEpochMs={referenceEpochMs} />
      <SheetEmbedDescription embed={embed} labels={labels} referenceEpochMs={referenceEpochMs} />
      <SheetEmbedFields embed={embed} labels={labels} referenceEpochMs={referenceEpochMs} />
      <SheetEmbedFooter embed={embed} labels={labels} referenceEpochMs={referenceEpochMs} />
    </div>
  </div>
);

const buttonStyles = {
  primary: "bg-[#5865f2] text-white",
  secondary: "bg-[#4e5058] text-white",
  success: "bg-[#248046] text-white",
  danger: "bg-[#da373c] text-white",
} as const;

type RenderedButton = SheetActionButton & { readonly url?: string };

const SheetButtonContent = ({ button }: { button: RenderedButton }) => (
  <>
    {button.emoji === undefined ? null : (
      <span>{button.emoji.id === undefined ? button.emoji.name : `:${button.emoji.name}:`}</span>
    )}
    {button.label}
    {button.url === undefined ? null : <span aria-hidden="true">↗</span>}
  </>
);

const SheetButton = ({ button }: { button: RenderedButton }) => {
  const className = `inline-flex min-h-8 items-center gap-1.5 rounded-[3px] px-3.5 py-1.5 text-sm font-medium ${buttonStyles[button.style ?? "primary"]} ${button.disabled ? "cursor-not-allowed opacity-50" : ""}`;
  return button.url !== undefined && !button.disabled ? (
    <a href={button.url} className={className} rel="noreferrer">
      <SheetButtonContent button={button} />
    </a>
  ) : (
    <span className={className} aria-disabled={button.disabled || undefined}>
      <SheetButtonContent button={button} />
    </span>
  );
};

const SheetActionRowView = ({ row }: { row: SheetMessageActionRow }) => (
  <div className="mt-2 flex flex-wrap gap-2">
    {row.components.map((button, index) => (
      <SheetButton key={index} button={button} />
    ))}
  </div>
);

const HashIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5 fill-[#b5bac1]">
    <path d="M5.89 21 7 17H3.5l.61-2H7.56l1.1-4H5l.61-2h3.6l1.1-4h2.08l-1.1 4h4.38l1.1-4h2.08l-1.1 4H21.5l-.61 2h-3.77l-1.1 4h3.48l-.61 2h-3.42l-1.1 4h-2.08l1.1-4H9.02l-1.1 4H5.89Zm3.68-6h4.38l1.1-4h-4.38l-1.1 4Z" />
  </svg>
);

const EyeIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-current">
    <path d="M12 5c5.23 0 9.27 4.37 10.54 6.05.3.4.3 1 0 1.4C21.27 14.13 17.23 18.5 12 18.5S2.73 14.13 1.46 12.45a1.16 1.16 0 0 1 0-1.4C2.73 9.37 6.77 5 12 5Zm0 2C8.14 7 4.86 10.02 3.55 11.75 4.86 13.48 8.14 16.5 12 16.5s7.14-3.02 8.45-4.75C19.14 10.02 15.86 7 12 7Zm0 1.5a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5Z" />
  </svg>
);

const DiscordLocation = ({
  channel,
  delivery,
  server,
}: {
  readonly channel: string;
  readonly delivery: "channel" | "direct";
  readonly server: string;
}) => (
  <figcaption className="flex min-h-12 items-center gap-2 border-b border-[#1f2023] bg-[#2b2d31] px-4 shadow-[0_1px_0_rgba(4,4,5,0.2),0_2px_8px_rgba(0,0,0,0.14)]">
    {delivery === "channel" ? <HashIcon /> : <span className="text-lg text-[#b5bac1]">@</span>}
    <span className="truncate text-[15px] font-semibold text-[#f2f3f5]">{channel}</span>
    <span className="h-5 w-px bg-[#3f4147]" />
    <span className="truncate text-xs text-[#949ba4]">
      {delivery === "channel" ? server : "Direct Message"}
    </span>
  </figcaption>
);

const CommandInvocation = ({ command }: { readonly command: DiscordCommandInvocation }) => (
  <div className="relative mx-4 flex items-center gap-1.5 pl-[52px] pt-3 text-[13px] leading-5">
    <svg
      aria-hidden="true"
      viewBox="0 0 52 28"
      className="pointer-events-none absolute left-0 top-3 h-7 w-[52px] overflow-visible text-[#4e5058]"
    >
      <path
        d="M20 25V17C20 14.24 22.24 12 25 12H49"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(145deg,#ffd6e7,#735bf2)] text-[8px] font-black text-[#26272b]"
    >
      <span className="block -translate-y-px leading-none">
        {(command.userName ?? "Theerie").slice(0, 1).toUpperCase()}
      </span>
    </span>
    <span className="font-semibold text-[#5c9cf5]">{command.userName ?? "Theerie"}</span>
    <span className="text-[#b5bac1]">used</span>
    <span className="rounded-[3px] bg-[#3c4270] px-1.5 py-0.5 font-medium text-[#c9cdfb]">
      /{command.name}
    </span>
  </div>
);

const EphemeralNotice = () => (
  <div className="mt-2 flex items-center gap-1 text-xs text-[#949ba4]">
    <EyeIcon />
    <span>Only you can see this</span>
    <span aria-hidden="true">·</span>
    <span className="font-medium text-[#5c9cf5]">Dismiss message</span>
  </div>
);

const OptionalCommandInvocation = ({
  command,
}: {
  readonly command: DiscordCommandInvocation | undefined;
}) => (command === undefined ? null : <CommandInvocation command={command} />);

const MessageContent = ({
  labels,
  message,
  referenceEpochMs,
}: {
  readonly labels: Labels;
  readonly message: SheetOutboundMessage;
  readonly referenceEpochMs: number;
}) =>
  message.content == null ? null : (
    <div className="whitespace-pre-wrap break-words">
      <SheetTextView value={message.content} labels={labels} referenceEpochMs={referenceEpochMs} />
    </div>
  );

const MessageEmbeds = ({
  labels,
  message,
  referenceEpochMs,
}: {
  readonly labels: Labels;
  readonly message: SheetOutboundMessage;
  readonly referenceEpochMs: number;
}) =>
  message.embeds?.map((embed, index) => (
    <SheetEmbed key={index} embed={embed} labels={labels} referenceEpochMs={referenceEpochMs} />
  ));

const MessageComponents = ({ message }: { readonly message: SheetOutboundMessage }) =>
  message.components?.map((row, index) => <SheetActionRowView key={index} row={row} />);

const OptionalEphemeralNotice = ({ message }: { readonly message: SheetOutboundMessage }) =>
  message.visibility === "ephemeral" ? <EphemeralNotice /> : null;

const messagePadding = (command: DiscordCommandInvocation | undefined) =>
  command === undefined ? "pt-4" : "pt-1";

export const DiscordMessage = ({
  message,
  labels = {},
  delivery = "channel",
  channel = "marathon-room",
  server = "Sekai Tiering",
  command,
  referenceEpochMs,
}: {
  message: SheetOutboundMessage;
  labels?: Labels;
  delivery?: "channel" | "direct";
  channel?: string;
  server?: string;
  command?: DiscordCommandInvocation;
  referenceEpochMs: number;
}) => (
  <figure className="not-prose my-6 overflow-hidden rounded-lg border border-[#111214] bg-[#313338] font-sans shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
    <DiscordLocation channel={channel} delivery={delivery} server={server} />
    <OptionalCommandInvocation command={command} />
    <div
      className={`flex gap-3 px-4 pb-4 text-sm leading-[1.375rem] text-[#dbdee1] ${messagePadding(command)}`}
    >
      <div
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-full bg-[conic-gradient(from_30deg,#7ee8e1,#5e70e8,#ff9fc9,#7ee8e1)] p-[2px] text-lg font-black text-white shadow-md"
      >
        <span className="grid size-full place-items-center rounded-full bg-[#25284a]">T</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="font-semibold text-[#f2f3f5]">TiaraBot</span>
          <span className="rounded bg-[#5865f2] px-1 text-[10px] font-bold leading-4 text-white">
            APP
          </span>
          <span className="text-xs text-[#949ba4]">Today at 12:00 PM</span>
        </div>
        <MessageContent message={message} labels={labels} referenceEpochMs={referenceEpochMs} />
        <MessageEmbeds message={message} labels={labels} referenceEpochMs={referenceEpochMs} />
        <MessageComponents message={message} />
        <OptionalEphemeralNotice message={message} />
      </div>
    </div>
  </figure>
);

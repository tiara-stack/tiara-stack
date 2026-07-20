import {
  APIApplicationCommandOptionChoice,
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
} from "discord-api-types/v10";
import {
  ApplicationCommandOptionBase,
  SharedNameAndDescription,
  SharedSlashCommand,
  SharedSlashCommandOptions,
  SlashCommandBooleanOption,
  SlashCommandBuilder,
  SlashCommandChannelOption,
  SlashCommandIntegerOption,
  SlashCommandNumberOption,
  SlashCommandRoleOption,
  SlashCommandStringOption,
  SharedSlashCommandSubcommands,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  SlashCommandUserOption,
  SlashCommandAttachmentOption,
  SlashCommandMentionableOption,
} from "@discordjs/builders";
import { Types } from "effect";

interface BuilderTypeLambda<BaseBuilderType> {
  readonly BaseBuilderType: BaseBuilderType;
  readonly InnerType: unknown;
}

interface JsonBuilder {
  toJSON(): unknown;
}

type BuilderKind<F extends BuilderTypeLambda<unknown>, InnerType> = F extends {
  readonly BuilderType: unknown;
}
  ? F & {
      readonly InnerType: InnerType;
    }
  : never;

type BaseBuilderType<F extends BuilderTypeLambda<unknown>> = F["BaseBuilderType"];
type BuilderType<F extends BuilderTypeLambda<unknown>, InnerType> = BuilderKind<
  F,
  InnerType
>["BuilderType"];

const BuilderStateTypeId = Symbol("CommandBuilder/BuilderStateTypeId");

interface BuilderState<out InnerType> {
  readonly [BuilderStateTypeId]: Types.Covariant<InnerType>;
}

type BuilderInnerType<B> = B extends BuilderState<infer InnerType> ? InnerType : never;

const builderState =
  <InnerType>(): BuilderState<InnerType>[typeof BuilderStateTypeId] =>
  (value) =>
    value;

type ReplaceKey<A, Key extends string, Value> = Types.Simplify<
  Omit<A, Key> & { [K in Key]: Value }
>;
type AppendKey<A, Key extends string, Value> = Types.Simplify<
  Omit<A, Key> & {
    [K in Key]: K extends keyof A
      ? A[K] extends infer Arr extends ReadonlyArray<unknown>
        ? [...Arr, Value]
        : [Value]
      : [Value];
  }
>;
type AppendAllKey<A, Key extends string, Value extends ReadonlyArray<unknown>> = Types.Simplify<
  Omit<A, Key> & {
    [K in Key]: K extends keyof A
      ? A[K] extends infer Arr extends ReadonlyArray<unknown>
        ? [...Arr, ...Value]
        : Value
      : Value;
  }
>;

abstract class SharedBuilderToJSON<
  BuilderT extends BuilderTypeLambda<JsonBuilder>,
  InnerType = unknown,
> {
  readonly [BuilderStateTypeId] = builderState<InnerType>();
  abstract readonly builder: BaseBuilderType<BuilderT>;

  toJSON(): InnerType {
    return this.builder.toJSON() as InnerType;
  }
}

export abstract class SharedNameAndDescriptionBuilder<
  BuilderT extends BuilderTypeLambda<SharedNameAndDescription>,
  InnerType = unknown,
> {
  readonly [BuilderStateTypeId] = builderState<InnerType>();
  abstract readonly builder: BaseBuilderType<BuilderT>;

  setName<const Name extends string>(name: Name) {
    this.builder.setName(name);
    return this as unknown as BuilderType<
      BuilderT,
      ReplaceKey<BuilderInnerType<typeof this>, "name", Name>
    >;
  }

  setDescription<const Description extends string>(description: Description) {
    this.builder.setDescription(description);
    return this as unknown as BuilderType<
      BuilderT,
      ReplaceKey<InnerType, "description", Description>
    >;
  }
}

export abstract class SharedCommand<
  BuilderT extends BuilderTypeLambda<SharedSlashCommand>,
  InnerType = unknown,
> {
  readonly [BuilderStateTypeId] = builderState<InnerType>();
  abstract readonly builder: BaseBuilderType<BuilderT>;

  setContexts<const Contexts extends ReadonlyArray<InteractionContextType>>(...contexts: Contexts) {
    this.builder.setContexts(...contexts);
    return this as unknown as BuilderType<
      BuilderT,
      ReplaceKey<BuilderInnerType<typeof this>, "contexts", Contexts>
    >;
  }

  setIntegrationTypes<const IntegrationTypes extends ReadonlyArray<ApplicationIntegrationType>>(
    ...integrationTypes: IntegrationTypes
  ) {
    this.builder.setIntegrationTypes(...integrationTypes);
    return this as unknown as BuilderType<
      BuilderT,
      ReplaceKey<InnerType, "integration_types", IntegrationTypes>
    >;
  }

  setDefaultMemberPermissions<const DefaultMemberPermissions extends bigint>(
    defaultMemberPermissions: DefaultMemberPermissions,
  ) {
    this.builder.setDefaultMemberPermissions(defaultMemberPermissions);
    return this as unknown as BuilderType<
      BuilderT,
      ReplaceKey<InnerType, "default_member_permissions", DefaultMemberPermissions>
    >;
  }

  setNSFW<const NSFW extends boolean>(nsfw: NSFW) {
    this.builder.setNSFW(nsfw);
    return this as unknown as BuilderType<BuilderT, ReplaceKey<InnerType, "nsfw", NSFW>>;
  }
}

export abstract class CommandOptionBuilder<
  BuilderT extends BuilderTypeLambda<ApplicationCommandOptionBase>,
  InnerType = unknown,
> extends SharedNameAndDescriptionBuilder<BuilderT, InnerType> {
  setRequired<const Required extends boolean>(required: Required) {
    this.builder.setRequired(required);
    return this as unknown as BuilderType<BuilderT, ReplaceKey<InnerType, "required", Required>>;
  }
}

interface AttachmentOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandAttachmentOption> {
  readonly BuilderType: AttachmentOptionBuilder<this["InnerType"]>;
}

export class AttachmentOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.Attachment },
> extends CommandOptionBuilder<AttachmentOptionBuilderTypeLambda, A> {
  builder = new SlashCommandAttachmentOption();
}

interface BooleanOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandBooleanOption> {
  readonly BuilderType: BooleanOptionBuilder<this["InnerType"]>;
}

export class BooleanOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.Boolean },
> extends CommandOptionBuilder<BooleanOptionBuilderTypeLambda, A> {
  builder = new SlashCommandBooleanOption();
}

type AllowedChannelTypes =
  | ChannelType.GuildText
  | ChannelType.GuildVoice
  | ChannelType.GuildCategory
  | ChannelType.GuildAnnouncement
  | ChannelType.AnnouncementThread
  | ChannelType.PublicThread
  | ChannelType.PrivateThread
  | ChannelType.GuildStageVoice
  | ChannelType.GuildForum
  | ChannelType.GuildMedia;

interface ChannelOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandChannelOption> {
  readonly BuilderType: ChannelOptionBuilder<this["InnerType"]>;
}

export class ChannelOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.Channel },
> extends CommandOptionBuilder<ChannelOptionBuilderTypeLambda, A> {
  readonly builder = new SlashCommandChannelOption();

  addChannelTypes<const ChannelTypes extends ReadonlyArray<AllowedChannelTypes>>(
    ...channelTypes: ChannelTypes
  ): BuilderType<ChannelOptionBuilderTypeLambda, AppendAllKey<A, "channel_types", ChannelTypes>> {
    this.builder.addChannelTypes(...channelTypes);
    return this as unknown as BuilderType<
      ChannelOptionBuilderTypeLambda,
      AppendAllKey<A, "channel_types", ChannelTypes>
    >;
  }
}

interface IntegerOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandIntegerOption> {
  readonly BuilderType: IntegerOptionBuilder<this["InnerType"]>;
}

export class IntegerOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.Integer },
> extends CommandOptionBuilder<IntegerOptionBuilderTypeLambda, A> {
  readonly builder = new SlashCommandIntegerOption();

  setMinValue<const MinValue extends number>(minValue: MinValue) {
    this.builder.setMinValue(minValue);
    return this as unknown as BuilderType<
      IntegerOptionBuilderTypeLambda,
      ReplaceKey<A, "min_value", MinValue>
    >;
  }

  setMaxValue<const MaxValue extends number>(maxValue: MaxValue) {
    this.builder.setMaxValue(maxValue);
    return this as unknown as BuilderType<
      IntegerOptionBuilderTypeLambda,
      ReplaceKey<A, "max_value", MaxValue>
    >;
  }

  addChoices<const Choices extends ReadonlyArray<APIApplicationCommandOptionChoice<number>>>(
    ...choices: Choices
  ) {
    this.builder.addChoices(...choices);
    return this as unknown as BuilderType<
      IntegerOptionBuilderTypeLambda,
      AppendAllKey<A, "choices", Choices>
    >;
  }

  setChoices<const Choices extends ReadonlyArray<APIApplicationCommandOptionChoice<number>>>(
    ...choices: Choices
  ) {
    this.builder.setChoices(...choices);
    return this as unknown as BuilderType<
      IntegerOptionBuilderTypeLambda,
      ReplaceKey<A, "choices", Choices>
    >;
  }

  setAutocomplete<const Autocomplete extends boolean>(autocomplete: Autocomplete) {
    this.builder.setAutocomplete(autocomplete);
    return this as unknown as BuilderType<
      IntegerOptionBuilderTypeLambda,
      ReplaceKey<A, "autocomplete", Autocomplete>
    >;
  }
}

interface MentionableOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandMentionableOption> {
  readonly BuilderType: MentionableOptionBuilder<this["InnerType"]>;
}

export class MentionableOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.Mentionable },
> extends CommandOptionBuilder<MentionableOptionBuilderTypeLambda, A> {
  readonly builder = new SlashCommandMentionableOption();
}

interface NumberOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandNumberOption> {
  readonly BuilderType: NumberOptionBuilder<this["InnerType"]>;
}

export class NumberOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.Number },
> extends CommandOptionBuilder<NumberOptionBuilderTypeLambda, A> {
  readonly builder = new SlashCommandNumberOption();

  setMinValue<const MinValue extends number>(minValue: MinValue) {
    this.builder.setMinValue(minValue);
    return this as unknown as BuilderType<
      NumberOptionBuilderTypeLambda,
      ReplaceKey<A, "min_value", MinValue>
    >;
  }

  setMaxValue<const MaxValue extends number>(maxValue: MaxValue) {
    this.builder.setMaxValue(maxValue);
    return this as unknown as BuilderType<
      NumberOptionBuilderTypeLambda,
      ReplaceKey<A, "max_value", MaxValue>
    >;
  }

  addChoices<const Choices extends ReadonlyArray<APIApplicationCommandOptionChoice<number>>>(
    ...choices: Choices
  ) {
    this.builder.addChoices(...choices);
    return this as unknown as BuilderType<
      NumberOptionBuilderTypeLambda,
      AppendAllKey<A, "choices", Choices>
    >;
  }

  setChoices<const Choices extends ReadonlyArray<APIApplicationCommandOptionChoice<number>>>(
    ...choices: Choices
  ) {
    this.builder.setChoices(...choices);
    return this as unknown as BuilderType<
      NumberOptionBuilderTypeLambda,
      ReplaceKey<A, "choices", Choices>
    >;
  }

  setAutocomplete<const Autocomplete extends boolean>(autocomplete: Autocomplete) {
    this.builder.setAutocomplete(autocomplete);
    return this as unknown as BuilderType<
      NumberOptionBuilderTypeLambda,
      ReplaceKey<A, "autocomplete", Autocomplete>
    >;
  }
}

interface RoleOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandRoleOption> {
  readonly BuilderType: RoleOptionBuilder<this["InnerType"]>;
}

export class RoleOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.Role },
> extends CommandOptionBuilder<RoleOptionBuilderTypeLambda, A> {
  readonly builder = new SlashCommandRoleOption();
}

interface StringOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandStringOption> {
  readonly BuilderType: StringOptionBuilder<this["InnerType"]>;
}

export class StringOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.String },
> extends CommandOptionBuilder<StringOptionBuilderTypeLambda, A> {
  readonly builder = new SlashCommandStringOption();

  addChoices<const Choices extends ReadonlyArray<APIApplicationCommandOptionChoice<string>>>(
    ...choices: Choices
  ) {
    this.builder.addChoices(...choices);
    return this as unknown as BuilderType<
      StringOptionBuilderTypeLambda,
      AppendAllKey<A, "choices", Choices>
    >;
  }

  setChoices<const Choices extends ReadonlyArray<APIApplicationCommandOptionChoice<string>>>(
    ...choices: Choices
  ) {
    this.builder.setChoices(...choices);
    return this as unknown as BuilderType<
      StringOptionBuilderTypeLambda,
      ReplaceKey<A, "choices", Choices>
    >;
  }

  setAutocomplete<const Autocomplete extends boolean>(autocomplete: Autocomplete) {
    this.builder.setAutocomplete(autocomplete);
    return this as unknown as BuilderType<
      StringOptionBuilderTypeLambda,
      ReplaceKey<A, "autocomplete", Autocomplete>
    >;
  }

  setMinLength<const MinLength extends number>(minLength: MinLength) {
    this.builder.setMinLength(minLength);
    return this as unknown as BuilderType<
      StringOptionBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "min_length", MinLength>
    >;
  }

  setMaxLength<const MaxLength extends number>(maxLength: MaxLength) {
    this.builder.setMaxLength(maxLength);
    return this as unknown as BuilderType<
      StringOptionBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "max_length", MaxLength>
    >;
  }
}

interface UserOptionBuilderTypeLambda extends BuilderTypeLambda<SlashCommandUserOption> {
  readonly BuilderType: UserOptionBuilder<this["InnerType"]>;
}

export class UserOptionBuilder<
  A = { type: typeof ApplicationCommandOptionType.User },
> extends CommandOptionBuilder<UserOptionBuilderTypeLambda, A> {
  readonly builder = new SlashCommandUserOption();
}

abstract class SharedCommandOptionsBuilder<
  BuilderT extends BuilderTypeLambda<
    SharedSlashCommandOptions<SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandBuilder>
  >,
  InnerType = unknown,
> {
  readonly [BuilderStateTypeId] = builderState<InnerType>();
  abstract readonly builder: BaseBuilderType<BuilderT>;

  addBooleanOption<const InnerOption>(
    input: (builder: BooleanOptionBuilder) => BooleanOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addBooleanOption(input(new BooleanOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addUserOption<const InnerOption>(
    input: (builder: UserOptionBuilder) => UserOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addUserOption(input(new UserOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addChannelOption<const InnerOption>(
    input: (builder: ChannelOptionBuilder) => ChannelOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addChannelOption(input(new ChannelOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addRoleOption<const InnerOption>(
    input: (builder: RoleOptionBuilder) => RoleOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addRoleOption(input(new RoleOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addAttachmentOption<const InnerOption>(
    input: (builder: AttachmentOptionBuilder) => AttachmentOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addAttachmentOption(input(new AttachmentOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addMentionableOption<const InnerOption>(
    input: (builder: MentionableOptionBuilder) => MentionableOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addMentionableOption(input(new MentionableOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addStringOption<const InnerOption>(
    input: (builder: StringOptionBuilder) => StringOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addStringOption(input(new StringOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addIntegerOption<const InnerOption>(
    input: (builder: IntegerOptionBuilder) => IntegerOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addIntegerOption(input(new IntegerOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addNumberOption<const InnerOption>(
    input: (builder: NumberOptionBuilder) => NumberOptionBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addNumberOption(input(new NumberOptionBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }
}

interface SubCommandGroupBuilderTypeLambda extends BuilderTypeLambda<SlashCommandSubcommandGroupBuilder> {
  readonly BuilderType: SubCommandGroupBuilder<this["InnerType"]>;
}

export class SubCommandGroupBuilder<
  A = { type: typeof ApplicationCommandOptionType.SubcommandGroup },
> extends SharedNameAndDescriptionBuilder<SubCommandGroupBuilderTypeLambda, A> {
  readonly builder = new SlashCommandSubcommandGroupBuilder();

  addSubcommand<const InnerOption>(
    input: (builder: SubCommandBuilder) => SubCommandBuilder<InnerOption>,
  ): BuilderType<SubCommandGroupBuilderTypeLambda, AppendKey<A, "options", InnerOption>> {
    this.builder.addSubcommand(input(new SubCommandBuilder()).builder);
    return this as unknown as BuilderType<
      SubCommandGroupBuilderTypeLambda,
      AppendKey<A, "options", InnerOption>
    >;
  }

  toJSON(): A {
    return this.builder.toJSON() as A;
  }
}

interface SubCommandBuilderTypeLambda extends BuilderTypeLambda<SlashCommandSubcommandBuilder> {
  readonly BuilderType: SubCommandBuilder<this["InnerType"]>;
}

export class SubCommandBuilder<
  A = { type: typeof ApplicationCommandOptionType.Subcommand },
> extends SharedCommandOptionsBuilder<SubCommandBuilderTypeLambda, A> {
  readonly builder = new SlashCommandSubcommandBuilder();

  setName<const Name extends string>(name: Name) {
    this.builder.setName(name);
    return this as unknown as BuilderType<SubCommandBuilderTypeLambda, ReplaceKey<A, "name", Name>>;
  }

  setDescription<const Description extends string>(description: Description) {
    this.builder.setDescription(description);
    return this as unknown as BuilderType<
      SubCommandBuilderTypeLambda,
      ReplaceKey<A, "description", Description>
    >;
  }

  toJSON(): A {
    return this.builder.toJSON() as A;
  }
}

abstract class SharedCommandSubCommandsBuilder<
  BuilderT extends BuilderTypeLambda<
    SharedSlashCommandSubcommands<SlashCommandSubcommandsOnlyBuilder>
  >,
  InnerType = unknown,
> {
  readonly [BuilderStateTypeId] = builderState<InnerType>();
  abstract readonly builder: BaseBuilderType<BuilderT>;

  addSubcommandGroup<const InnerOption>(
    input: (builder: SubCommandGroupBuilder) => SubCommandGroupBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addSubcommandGroup(input(new SubCommandGroupBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }

  addSubcommand<const InnerOption>(
    input: (builder: SubCommandBuilder) => SubCommandBuilder<InnerOption>,
  ): BuilderType<BuilderT, AppendKey<InnerType, "options", InnerOption>> {
    this.builder.addSubcommand(input(new SubCommandBuilder()).builder);
    return this as unknown as BuilderType<
      BuilderT,
      AppendKey<BuilderInnerType<typeof this>, "options", InnerOption>
    >;
  }
}

interface CommandBuilderTypeLambda extends BuilderTypeLambda<SlashCommandBuilder> {
  readonly BuilderType: CommandBuilder<this["InnerType"]>;
}

interface CommandOptionsOnlyBuilderTypeLambda extends BuilderTypeLambda<SlashCommandOptionsOnlyBuilder> {
  readonly BuilderType: CommandOptionsOnlyBuilder<this["InnerType"]>;
}

export interface CommandOptionsOnlyBuilder<A = unknown>
  extends
    SharedNameAndDescriptionBuilder<CommandOptionsOnlyBuilderTypeLambda, A>,
    SharedCommandOptionsBuilder<CommandOptionsOnlyBuilderTypeLambda, A>,
    SharedCommand<CommandOptionsOnlyBuilderTypeLambda, A>,
    SharedBuilderToJSON<CommandOptionsOnlyBuilderTypeLambda, A> {}

interface CommandSubCommandsOnlyBuilderTypeLambda extends BuilderTypeLambda<SlashCommandSubcommandsOnlyBuilder> {
  readonly BuilderType: CommandSubCommandsOnlyBuilder<this["InnerType"]>;
}

export interface CommandSubCommandsOnlyBuilder<A = unknown>
  extends
    SharedNameAndDescriptionBuilder<CommandSubCommandsOnlyBuilderTypeLambda, A>,
    SharedCommandSubCommandsBuilder<CommandSubCommandsOnlyBuilderTypeLambda, A>,
    SharedCommand<CommandSubCommandsOnlyBuilderTypeLambda, A>,
    SharedBuilderToJSON<CommandSubCommandsOnlyBuilderTypeLambda, A> {}

export class CommandBuilder<A = unknown> extends SharedCommandOptionsBuilder<
  CommandOptionsOnlyBuilderTypeLambda,
  A
> {
  readonly builder = new SlashCommandBuilder();

  setName<const Name extends string>(name: Name) {
    this.builder.setName(name);
    return this as unknown as BuilderType<CommandBuilderTypeLambda, ReplaceKey<A, "name", Name>>;
  }

  setDescription<const Description extends string>(description: Description) {
    this.builder.setDescription(description);
    return this as unknown as BuilderType<
      CommandBuilderTypeLambda,
      ReplaceKey<A, "description", Description>
    >;
  }

  setContexts<const Contexts extends ReadonlyArray<InteractionContextType>>(...contexts: Contexts) {
    this.builder.setContexts(...contexts);
    return this as unknown as BuilderType<
      CommandBuilderTypeLambda,
      ReplaceKey<A, "contexts", Contexts>
    >;
  }

  setIntegrationTypes<const IntegrationTypes extends ReadonlyArray<ApplicationIntegrationType>>(
    ...integrationTypes: IntegrationTypes
  ) {
    this.builder.setIntegrationTypes(...integrationTypes);
    return this as unknown as BuilderType<
      CommandBuilderTypeLambda,
      ReplaceKey<A, "integration_types", IntegrationTypes>
    >;
  }

  setDefaultMemberPermissions<const DefaultMemberPermissions extends bigint>(
    defaultMemberPermissions: DefaultMemberPermissions,
  ) {
    this.builder.setDefaultMemberPermissions(defaultMemberPermissions);
    return this as unknown as BuilderType<
      CommandBuilderTypeLambda,
      ReplaceKey<A, "default_member_permissions", DefaultMemberPermissions>
    >;
  }

  setNSFW<const NSFW extends boolean>(nsfw: NSFW) {
    this.builder.setNSFW(nsfw);
    return this as unknown as BuilderType<CommandBuilderTypeLambda, ReplaceKey<A, "nsfw", NSFW>>;
  }

  addSubcommandGroup<const InnerOption>(
    input: (builder: SubCommandGroupBuilder) => SubCommandGroupBuilder<InnerOption>,
  ): BuilderType<CommandSubCommandsOnlyBuilderTypeLambda, AppendKey<A, "options", InnerOption>> {
    this.builder.addSubcommandGroup(input(new SubCommandGroupBuilder()).builder);
    return this as unknown as BuilderType<
      CommandSubCommandsOnlyBuilderTypeLambda,
      AppendKey<A, "options", InnerOption>
    >;
  }

  addSubcommand<const InnerOption>(
    input: (builder: SubCommandBuilder) => SubCommandBuilder<InnerOption>,
  ): BuilderType<CommandSubCommandsOnlyBuilderTypeLambda, AppendKey<A, "options", InnerOption>> {
    this.builder.addSubcommand(input(new SubCommandBuilder()).builder);
    return this as unknown as BuilderType<
      CommandSubCommandsOnlyBuilderTypeLambda,
      AppendKey<A, "options", InnerOption>
    >;
  }

  toJSON(): A {
    return this.builder.toJSON() as A;
  }
}

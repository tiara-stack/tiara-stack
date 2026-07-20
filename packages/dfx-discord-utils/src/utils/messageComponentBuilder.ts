import {
  APIMessageComponentEmoji,
  ButtonStyle,
  ComponentType as DiscordComponentType,
  Snowflake,
} from "discord-api-types/v10";
import {
  ActionRowBuilder as BaseActionRowBuilder,
  ButtonBuilder as BaseButtonBuilder,
  ComponentBuilder as BaseComponentBuilder,
} from "@discordjs/builders";
import { Types } from "effect";

interface BuilderTypeLambda<BaseBuilderType> {
  readonly BaseBuilderType: BaseBuilderType;
  readonly InnerType: unknown;
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

const BuilderStateTypeId = Symbol("MessageComponentBuilder/BuilderStateTypeId");

interface BuilderState<out InnerType> {
  readonly [BuilderStateTypeId]: Types.Covariant<InnerType>;
}

type BuilderInnerType<B> = B extends BuilderState<infer InnerType> ? InnerType : never;

type BuilderInnerTypes<B extends ReadonlyArray<BuilderState<unknown>>> = B extends readonly [
  infer First extends BuilderState<unknown>,
  ...infer Rest extends ReadonlyArray<BuilderState<unknown>>,
]
  ? [BuilderInnerType<First>, ...BuilderInnerTypes<Rest>]
  : [];

const builderState =
  <InnerType>(): BuilderState<InnerType>[typeof BuilderStateTypeId] =>
  (value) =>
    value;

type ReplaceKey<A, Key extends string, Value> = Types.Simplify<
  Omit<A, Key> & { [K in Key]: Value }
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
  BuilderT extends BuilderTypeLambda<BaseComponentBuilder>,
  InnerType = unknown,
> {
  readonly [BuilderStateTypeId] = builderState<InnerType>();
  abstract readonly builder: BaseBuilderType<BuilderT>;

  toJSON(): InnerType {
    return this.builder.toJSON() as InnerType;
  }
}

abstract class ComponentBuilder<
  BuilderT extends BuilderTypeLambda<BaseComponentBuilder>,
  InnerType = unknown,
> extends SharedBuilderToJSON<BuilderT, InnerType> {
  setId<const Id extends number>(id: Id) {
    this.builder.setId(id);
    return this as unknown as BuilderType<BuilderT, ReplaceKey<InnerType, "id", Id>>;
  }

  clearId() {
    this.builder.clearId();
    return this as unknown as BuilderType<BuilderT, ReplaceKey<InnerType, "id", undefined>>;
  }
}

interface ButtonBuilderTypeLambda extends BuilderTypeLambda<BaseButtonBuilder> {
  readonly BuilderType: ButtonBuilder<this["InnerType"]>;
}

export class ButtonBuilder<
  A = { type: typeof DiscordComponentType.Button },
> extends ComponentBuilder<ButtonBuilderTypeLambda, A> {
  readonly builder = new BaseButtonBuilder();

  setStyle<const Style extends ButtonStyle>(style: Style) {
    this.builder.setStyle(style);
    return this as unknown as BuilderType<
      ButtonBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "style", Style>
    >;
  }

  setURL<const Url extends string>(url: Url) {
    this.builder.setURL(url);
    return this as unknown as BuilderType<
      ButtonBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "url", Url>
    >;
  }

  setCustomId<const CustomId extends string>(customId: CustomId) {
    this.builder.setCustomId(customId);
    return this as unknown as BuilderType<
      ButtonBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "custom_id", CustomId>
    >;
  }

  setSKUId<const SKUId extends Snowflake>(skuId: SKUId) {
    this.builder.setSKUId(skuId);
    return this as unknown as BuilderType<
      ButtonBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "sku_id", SKUId>
    >;
  }

  setEmoji<const Emoji extends APIMessageComponentEmoji>(emoji: Emoji) {
    this.builder.setEmoji(emoji);
    return this as unknown as BuilderType<
      ButtonBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "emoji", Emoji>
    >;
  }

  setDisabled<const Disabled extends boolean>(disabled: Disabled) {
    this.builder.setDisabled(disabled);
    return this as unknown as BuilderType<
      ButtonBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "disabled", Disabled>
    >;
  }

  setLabel<const Label extends string>(label: Label) {
    this.builder.setLabel(label);
    return this as unknown as BuilderType<
      ButtonBuilderTypeLambda,
      ReplaceKey<BuilderInnerType<typeof this>, "label", Label>
    >;
  }
}

export type MessageActionRowComponentBuilder = ButtonBuilder<unknown>;
export type AnyComponentBuilder = MessageActionRowComponentBuilder;

interface ActionRowBuilderTypeLambda<
  ComponentBuilderType extends AnyComponentBuilder,
> extends BuilderTypeLambda<BaseActionRowBuilder<BaseButtonBuilder>> {
  readonly BuilderType: ActionRowBuilder<ComponentBuilderType, this["InnerType"]>;
}

export class ActionRowBuilder<
  ComponentBuilderType extends AnyComponentBuilder,
  A = { type: typeof DiscordComponentType.ActionRow },
> extends ComponentBuilder<ActionRowBuilderTypeLambda<ComponentBuilderType>, A> {
  readonly builder = new BaseActionRowBuilder<BaseButtonBuilder>();

  addComponents<const Components extends ReadonlyArray<ComponentBuilderType>>(
    ...components: Components
  ): BuilderType<
    ActionRowBuilderTypeLambda<ComponentBuilderType>,
    AppendAllKey<A, "components", BuilderInnerTypes<Components>>
  > {
    this.builder.addComponents(components.map((c) => c.builder));
    return this as unknown as BuilderType<
      ActionRowBuilderTypeLambda<ComponentBuilderType>,
      AppendAllKey<A, "components", BuilderInnerTypes<Components>>
    >;
  }

  setComponents<const Components extends ReadonlyArray<ComponentBuilderType>>(
    ...components: Components
  ): BuilderType<
    ActionRowBuilderTypeLambda<ComponentBuilderType>,
    ReplaceKey<A, "components", BuilderInnerTypes<Components>>
  > {
    this.builder.setComponents(components.map((c) => c.builder));
    return this as unknown as BuilderType<
      ActionRowBuilderTypeLambda<ComponentBuilderType>,
      ReplaceKey<A, "components", BuilderInnerTypes<Components>>
    >;
  }
}

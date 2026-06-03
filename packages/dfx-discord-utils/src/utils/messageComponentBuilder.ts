import { APIMessageComponentEmoji, ButtonStyle, Snowflake } from "discord-api-types/v10";
import {
  ActionRowBuilder as BaseActionRowBuilder,
  ButtonBuilder as BaseButtonBuilder,
  ComponentBuilder as BaseComponentBuilder,
} from "@discordjs/builders";
import { Function, Types } from "effect";
import { mix } from "ts-mixer";
import { Discord } from "dfx";

interface BuilderTypeLambda<BaseBuilderType> {
  readonly BaseBuilderType: BaseBuilderType;
  readonly InnerType: unknown;
}

type BuilderKind<F extends BuilderTypeLambda<any>, InnerType> = F extends {
  readonly BuilderType: unknown;
}
  ? F & {
      readonly InnerType: InnerType;
    }
  : never;

type BaseBuilderType<F extends BuilderTypeLambda<any>> = F["BaseBuilderType"];
type BuilderType<F extends BuilderTypeLambda<any>, InnerType> = BuilderKind<
  F,
  InnerType
>["BuilderType"];

const BuilderTypeId = Symbol("MessageComponentBuilder/BuilderTypeId");
type BuilderTypeId = typeof BuilderTypeId;

interface BuilderVariance<
  in out BuilderT extends BuilderTypeLambda<any>,
  in out InnerType extends unknown,
> {
  [BuilderTypeId]: {
    _BuilderT: Types.Invariant<BuilderT>;
    _InnerType: Types.Invariant<InnerType>;
  };
}

type BuilderBuilderT<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  B extends BuilderVariance<any, any>,
> = [B] extends [BuilderVariance<infer BuilderT, any>] ? BuilderT : never;

type BuilderInnerType<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  B extends BuilderVariance<any, any>,
> = [B] extends [BuilderVariance<any, infer InnerType>] ? InnerType : never;

type BuilderInnerTypes<B extends ReadonlyArray<BuilderVariance<any, any>>> = B extends readonly [
  infer First extends BuilderVariance<any, any>,
  ...infer Rest extends ReadonlyArray<BuilderVariance<any, any>>,
]
  ? [BuilderInnerType<First>, ...BuilderInnerTypes<Rest>]
  : [];

const builderVariance: <
  BuilderT extends BuilderTypeLambda<any>,
  InnerType extends unknown,
>() => BuilderVariance<BuilderT, InnerType>[BuilderTypeId] = () => ({
  _BuilderT: Function.identity,
  _InnerType: Function.identity,
});

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

abstract class SharedBuilderToJSON<BuilderT extends BuilderTypeLambda<any>, InnerType = unknown> {
  readonly [BuilderTypeId] = builderVariance<BuilderT, InnerType>();
  abstract readonly builder: BaseBuilderType<BuilderT>;

  toJSON(): InnerType {
    return this.builder.toJSON() as InnerType;
  }
}

abstract class ComponentBuilder<
  BuilderT extends BuilderTypeLambda<BaseComponentBuilder<any>>,
  InnerType = unknown,
> {
  readonly [BuilderTypeId] = builderVariance<BuilderT, InnerType>();
  abstract readonly builder: BaseBuilderType<BuilderT>;

  setId<const Id extends number>(id: Id) {
    this.builder.setId(id);
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "id", Id>
    >;
  }

  clearId() {
    this.builder.clearId();
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<InnerType, "id", undefined>
    >;
  }
}

interface ButtonBuilderTypeLambda extends BuilderTypeLambda<BaseButtonBuilder> {
  readonly BuilderType: ButtonBuilder<this["InnerType"]>;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ButtonBuilder<A = { type: typeof Discord.MessageComponentTypes.BUTTON }>
  extends
    ComponentBuilder<ButtonBuilderTypeLambda, A>,
    SharedBuilderToJSON<ButtonBuilderTypeLambda, A> {}

@mix(ComponentBuilder, SharedBuilderToJSON)
export class ButtonBuilder<A = { type: typeof Discord.MessageComponentTypes.BUTTON }> {
  readonly builder = new BaseButtonBuilder();

  setStyle<const Style extends ButtonStyle>(style: Style) {
    this.builder.setStyle(style);
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "style", Style>
    >;
  }

  setURL<const Url extends string>(url: Url) {
    this.builder.setURL(url);
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "url", Url>
    >;
  }

  setCustomId<const CustomId extends string>(customId: CustomId) {
    this.builder.setCustomId(customId);
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "custom_id", CustomId>
    >;
  }

  setSKUId<const SKUId extends Snowflake>(skuId: SKUId) {
    this.builder.setSKUId(skuId);
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "sku_id", SKUId>
    >;
  }

  setEmoji<const Emoji extends APIMessageComponentEmoji>(emoji: Emoji) {
    this.builder.setEmoji(emoji);
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "emoji", Emoji>
    >;
  }

  setDisabled<const Disabled extends boolean>(disabled: Disabled) {
    this.builder.setDisabled(disabled);
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "disabled", Disabled>
    >;
  }

  setLabel<const Label extends string>(label: Label) {
    this.builder.setLabel(label);
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "label", Label>
    >;
  }

  toJSON(): A {
    return this.builder.toJSON() as A;
  }
}

export type MessageActionRowComponentBuilder = ButtonBuilder<any>;
export type AnyComponentBuilder = MessageActionRowComponentBuilder;

interface ActionRowBuilderTypeLambda<
  ComponentType extends AnyComponentBuilder,
> extends BuilderTypeLambda<BaseActionRowBuilder<any>> {
  readonly BuilderType: ActionRowBuilder<ComponentType, this["InnerType"]>;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ActionRowBuilder<
  ComponentType extends AnyComponentBuilder,
  A = { type: typeof Discord.MessageComponentTypes.ACTION_ROW },
>
  extends
    ComponentBuilder<ActionRowBuilderTypeLambda<ComponentType>, A>,
    SharedBuilderToJSON<ActionRowBuilderTypeLambda<ComponentType>, A> {}

export class ActionRowBuilder<
  ComponentType extends AnyComponentBuilder,
  A = { type: typeof Discord.MessageComponentTypes.ACTION_ROW },
> {
  readonly builder = new BaseActionRowBuilder();

  addComponent<const Components extends ReadonlyArray<ComponentType>>(
    ...components: Components
  ): BuilderType<
    BuilderBuilderT<typeof this>,
    AppendAllKey<A, "components", BuilderInnerTypes<Components>>
  > {
    this.builder.addComponents(components.map((c) => c.builder));
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      AppendAllKey<BuilderInnerType<typeof this>, "components", BuilderInnerTypes<Components>>
    >;
  }

  setComponents<const Components extends ReadonlyArray<ComponentType>>(
    ...components: Components
  ): BuilderType<
    BuilderBuilderT<typeof this>,
    ReplaceKey<A, "components", BuilderInnerTypes<Components>>
  > {
    this.builder.setComponents(components.map((c) => c.builder));
    return this as unknown as BuilderType<
      BuilderBuilderT<typeof this>,
      ReplaceKey<BuilderInnerType<typeof this>, "components", BuilderInnerTypes<Components>>
    >;
  }

  toJSON(): A {
    return this.builder.toJSON() as A;
  }
}

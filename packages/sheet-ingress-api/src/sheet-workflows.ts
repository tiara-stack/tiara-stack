import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { DispatchApi, HealthApi } from "./api-groups";

export class SheetWorkflowsApi extends HttpApi.make("api")
  .add(DispatchApi)
  .add(HealthApi)
  .annotate(OpenApi.Title, "Sheet Workflows") {}

import type { PermissionSet } from "sheet-ingress-api/schemas/permissions";
import {
  getEffectiveScheduleView,
  getMaximumScheduleView,
  type ScheduleView,
} from "sheet-ingress-api/schemas/sheet";

export const resolveScheduleViewFromPermissions = (
  permissions: PermissionSet,
  workspaceId: string,
  requestedView?: ScheduleView,
) => getEffectiveScheduleView(getMaximumScheduleView(permissions, workspaceId), requestedView);

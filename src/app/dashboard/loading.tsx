import { PrimaryRouteLoading } from "../skills/primary-route-loading";
import { primaryRouteLoadingByKey } from "../skills/primary-route-loading-content";

export default function Loading() {
  return (
    <PrimaryRouteLoading
      config={primaryRouteLoadingByKey.dashboard}
      current="dashboard"
      variant="dashboard"
    />
  );
}

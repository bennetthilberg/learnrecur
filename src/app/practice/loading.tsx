import { PrimaryRouteLoading } from "../skills/primary-route-loading";
import { primaryRouteLoadingByKey } from "../skills/primary-route-loading-content";

export default function Loading() {
  return (
    <PrimaryRouteLoading
      config={primaryRouteLoadingByKey.practice}
      current="practice"
      variant="practice"
    />
  );
}

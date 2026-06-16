import { PrimaryRouteLoading } from "../primary-route-loading";
import { primaryRouteLoadingByKey } from "../primary-route-loading-content";

export default function Loading() {
  return (
    <PrimaryRouteLoading
      config={primaryRouteLoadingByKey.new}
      current="new"
    />
  );
}

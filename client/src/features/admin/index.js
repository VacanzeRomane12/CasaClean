/*
 * Admin feature barrel
 * --------------------
 * Public surface of the admin panel: context providers/hooks, the shell layout
 * and the reusable building blocks pages compose.
 */

export * from "./context";
export * from "./components";
export {
  contentField,
  toContentValue,
  fromContentValue,
} from "./utils/localizedContent";
export {
  ADMIN_NAV,
  BOOKING_STATUS_META,
  CONTACT_STATUS_META,
  SUBSCRIPTION_STATUS_META,
  PAYMENT_STATUS_META,
  PROJECTED_STATUS,
  PROJECTED_STATUS_META,
  STATUS_COLORS,
} from "./constants";
export {
  mergeBookingsWithOccurrences,
  occurrenceFromApi,
} from "./utils/calendarOccurrences";

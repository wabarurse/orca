declare const ORCA2_BUILD_ID: string | undefined;
/** Compiled identity belongs to this loaded process, not the checkout on disk. */
export const BUILD_ID = typeof ORCA2_BUILD_ID === "undefined" ? "development" : ORCA2_BUILD_ID;

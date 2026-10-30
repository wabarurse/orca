// Shared with run admission: an interrupt invalidates all previously admitted work.
import { execution } from "../projects/lifecycle";
export const inputEpoch = execution.epoch;
export const advanceInputEpoch = execution.advance;

import { defineBackground, type PluginBackground } from "../../core/plugins";
import { rexRunner } from "./runner";

const background: PluginBackground = defineBackground({ watchers: [], memory: null, runner: rexRunner, stop: null, remove: null });

export default background;

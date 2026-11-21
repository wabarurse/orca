// The tmux plugin's daemon part: the runner.
import { defineBackground, type PluginBackground } from "../../core/plugins";
import { tmuxRunner } from "./runner";

const background: PluginBackground = defineBackground({ watchers: [], memory: null, runner: tmuxRunner, stop: null, remove: null });

export default background;

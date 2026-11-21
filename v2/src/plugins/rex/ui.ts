// The rex plugin's TUI part: the /mux command, shared with the tmux plugin.
import { defineUi, type PluginUi } from "../../core/plugins";
import { muxCommand } from "../tmux/mux";

const ui: PluginUi = defineUi({ tabs: [], counts: [], commands: [muxCommand], toolLines: {}, folds: {} });

export default ui;

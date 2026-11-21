import { defineUi, type PluginUi } from "../../core/plugins";
import { muxCommand } from "./mux";

const ui: PluginUi = defineUi({ tabs: [], counts: [], commands: [muxCommand], toolLines: {}, folds: {} });

export default ui;

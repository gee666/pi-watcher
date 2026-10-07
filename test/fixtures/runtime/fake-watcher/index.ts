// Stands in for the real pi-watcher extension: must NEVER load in the side agent.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fake-watcher-marker", { description: "must be excluded", handler: async () => {} });
	pi.registerFlag("fake-watcher-flag", { type: "boolean", description: "watcher-only flag" });
}

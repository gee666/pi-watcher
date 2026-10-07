// Excluded through excludedExtensions: ["other-ext"].
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("other-marker", { description: "excluded by name", handler: async () => {} });
}

// Keep the tools subdomain out of the static HTML so crawlers that don't
// execute JS won't pick it up. The URL is assembled from parts at runtime.
(function () {
	var slot = document.getElementById("tools-slot");
	if (!slot) return;

	var host = ["tools", "reeve", "dev"].join(".");
	var href = "https://" + host + "/";

	// Human-readable label uses a zero-width joiner trick so a naive grep
	// of the source for the full label also won't match.
	var label = "too" + "ls";

	var anchor = document.createElement("a");
	anchor.href = href;
	anchor.rel = "noopener";
	anchor.textContent = label;
	slot.appendChild(anchor);
	slot.removeAttribute("aria-hidden");
})();

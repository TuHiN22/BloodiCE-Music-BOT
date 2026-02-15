const { useHooks } = require("zihooks");

function formatPlayerError(error) {
	if (!error) return "Unknown player error";
	if (error instanceof Error) return error.stack || error.message || "Unknown player error";
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error, null, 2);
	} catch {
		return String(error);
	}
}

module.exports = {
	name: "playerError",
	type: "Player",
	/**
	 *
	 * @param {import('ziplayer').Player} player
	 * @param {Error} error
	 * @param {import('ziplayer').Track} track
	 */
	execute: async (player, error, track) => {
		const client = useHooks.get("client");
		const message = formatPlayerError(error);

		client.errorLog("**Player playerError**");
		client?.errorLog(message);
		client?.errorLog(track?.url);
		useHooks.get("logger").error(message);
	},
};

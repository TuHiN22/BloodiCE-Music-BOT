require("dotenv").config();
const { useHooks } = require("zihooks");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");

const { StartupManager } = require("./startup");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

//music player
const { default: PlayerManager } = require("ziplayer");
const { TTSPlugin, SoundCloudPlugin, YouTubePlugin, SpotifyPlugin, AttachmentsPlugin } = require("@ziplayer/plugin");
const { voiceExt } = require("@ziplayer/extension");
const client = new Client({
	rest: [{ timeout: 60_000 }],
	intents: [
		GatewayIntentBits.Guilds, // for guild related things
		GatewayIntentBits.GuildVoiceStates, // for voice related things
		GatewayIntentBits.GuildMessageReactions, // for message reactions things
		GatewayIntentBits.GuildMembers, // for guild members related things
		// GatewayIntentBits.GuildEmojisAndStickers, // for manage emojis and stickers
		// GatewayIntentBits.GuildIntegrations, // for discord Integrations
		// GatewayIntentBits.GuildWebhooks, // for discord webhooks
		GatewayIntentBits.GuildInvites, // for guild invite managing
		// GatewayIntentBits.GuildPresences, // for user presence things
		GatewayIntentBits.GuildMessages, // for guild messages things
		// GatewayIntentBits.GuildMessageTyping, // for message typing things
		GatewayIntentBits.DirectMessages, // for dm messages
		GatewayIntentBits.DirectMessageReactions, // for dm message reaction
		// GatewayIntentBits.DirectMessageTyping, // for dm message typinh
		GatewayIntentBits.MessageContent, // enable if you need message content things
	],
	partials: [Partials.User, Partials.GuildMember, Partials.Message, Partials.Channel],
	allowedMentions: {
		parse: ["users"],
		repliedUser: false,
	},
});
const ytbplg = new YouTubePlugin({ player: null });
const nativeYouTubeGetStream = ytbplg.getStream.bind(ytbplg);

function webStreamToNodeStream(webStream) {
	return new Readable({
		read() {
			// stream is pushed asynchronously below
		},
	});
}

async function convertWebStream(webStream, nodeStream) {
	const reader = webStream.getReader();
	try {
		while (true) {
			if (nodeStream.destroyed) {
				try {
					await reader.cancel();
				} catch {}
				break;
			}

			const { done, value } = await reader.read();
			if (done) {
				nodeStream.push(null);
				break;
			}
			nodeStream.push(Buffer.from(value));
		}
	} catch (error) {
		if (!nodeStream.destroyed) nodeStream.destroy(error);
	} finally {
		try {
			reader.releaseLock();
		} catch {}
	}
}

function getYtDlpPath() {
	const binName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
	const packageJsonPath = require.resolve("youtube-dl-exec/package.json");
	return path.join(path.dirname(packageJsonPath), "bin", binName);
}

function runYtDlpJson(url, timeoutMs = 45_000) {
	return new Promise((resolve, reject) => {
		const exePath = getYtDlpPath();
		const args = [
			url,
			"--dump-single-json",
			"--no-check-certificates",
			"--no-warnings",
			"--prefer-free-formats",
			"--format",
			"bestaudio/best",
		];

		const child = spawn(exePath, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error("yt-dlp timed out"));
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);

			if (code !== 0) {
				const tail = stderr.trim().split("\n").slice(-3).join(" | ");
				return reject(new Error(`yt-dlp exit ${code}: ${tail || "unknown error"}`));
			}

			try {
				const parsed = JSON.parse(stdout);
				resolve(parsed);
			} catch (error) {
				reject(new Error(`yt-dlp JSON parse failed: ${error?.message || error}`));
			}
		});
	});
}

function getHeaderValue(headers, key) {
	if (!headers || typeof headers !== "object") return undefined;
	if (headers[key] !== undefined) return headers[key];
	const lower = key.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (String(k).toLowerCase() === lower) return v;
	}
	return undefined;
}

async function getYouTubeStreamByYtDlp(track) {
	const info = await runYtDlpJson(track.url);
	const mediaUrl = info?.url;
	if (!mediaUrl) {
		throw new Error("yt-dlp did not return a media URL");
	}

	const ytHeaders = info?.http_headers || {};
	const requestHeaders = {
		"User-Agent":
			getHeaderValue(ytHeaders, "User-Agent") ||
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
		Referer: getHeaderValue(ytHeaders, "Referer") || "https://www.youtube.com/",
		Origin: getHeaderValue(ytHeaders, "Origin") || "https://www.youtube.com",
		Accept: "*/*",
	};

	let response = await fetch(mediaUrl, { headers: requestHeaders });
	if (!response.ok || !response.body) {
		// Retry once with minimal headers in case URL-bound headers change.
		response = await fetch(mediaUrl, {
			headers: {
				"User-Agent": requestHeaders["User-Agent"],
				Referer: "https://www.youtube.com/",
			},
		});
	}

	if (!response.ok || !response.body) {
		throw new Error(`yt-dlp media fetch failed with status ${response.status}`);
	}

	const nodeStream = webStreamToNodeStream(response.body);
	void convertWebStream(response.body, nodeStream);

	return {
		stream: nodeStream,
		type: "arbitrary",
		metadata: track.metadata,
	};
}

ytbplg.getStream = async function (track) {
	const url = track?.url || "";

	// Keep normal behavior for non-YouTube URLs handled via fallback chain.
	if (!this.validate?.(url)) {
		return await nativeYouTubeGetStream(track);
	}

	// Prefer direct yt-dlp transport (works with spaces in path), then fall back.
	try {
		return await getYouTubeStreamByYtDlp(track);
	} catch (ytDlpError) {
		try {
			return await nativeYouTubeGetStream(track);
		} catch (nativeError) {
			throw new Error(
				`YouTube stream failed (yt-dlp: ${ytDlpError?.message || ytDlpError}; native: ${nativeError?.message || nativeError})`,
			);
		}
	}
};

const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]);

function isSoundCloudUrl(url) {
	try {
		const parsed = new URL(url);
		return SOUNDCLOUD_HOSTS.has(parsed.hostname.toLowerCase());
	} catch {
		return false;
	}
}

function isRecoverableSoundCloudError(error) {
	const message = (error?.message || String(error || "")).toLowerCase();
	return (
		message.includes("failed to fetch item details") ||
		message.includes("soundcloud download returned null") ||
		message.includes("failed to get soundcloud stream") ||
		message.includes("soundcloud search failed")
	);
}

function wrapSoundCloudMethodWithRetry(plugin, methodName) {
	const original = plugin?.[methodName];
	if (typeof original !== "function") return;

	plugin[methodName] = async function (...args) {
		if (methodName === "getStream") {
			const track = args[0];
			if (!isSoundCloudUrl(track?.url || "")) {
				throw new Error("SoundCloud stream skipped for non-SoundCloud URL");
			}
		}

		if (methodName === "getFallback") {
			const track = args[0];
			const isSCTrack = track?.source === "soundcloud" || isSoundCloudUrl(track?.url || "");
			if (!isSCTrack) {
				throw new Error("SoundCloud fallback skipped for non-SoundCloud track");
			}
		}

		try {
			return await original.apply(this, args);
		} catch (error) {
			if (!isRecoverableSoundCloudError(error)) throw error;

			await this.init();
			return await original.apply(this, args);
		}
	};
}

function createResilientSoundCloudPlugin() {
	const plugin = new SoundCloudPlugin();
	wrapSoundCloudMethodWithRetry(plugin, "search");
	wrapSoundCloudMethodWithRetry(plugin, "getStream");
	wrapSoundCloudMethodWithRetry(plugin, "getFallback");
	wrapSoundCloudMethodWithRetry(plugin, "extractPlaylist");
	return plugin;
}

const soundCloudPlugin = createResilientSoundCloudPlugin();

//create Player Manager
const manager = new PlayerManager({
	plugins: [new TTSPlugin(), ytbplg, soundCloudPlugin, new SpotifyPlugin(), new AttachmentsPlugin()],
	extensions: [new voiceExt(null, { client, minimalVoiceMessageDuration: 1 })],
});
manager.create("search");

const startup = new StartupManager(client);
const logger = startup.getLogger();
const config = startup.getConfig();

const initialize = async () => {
	logger.info("Initializing Ziji Bot...");
	startup.initHooks();

	await Promise.all([
		startup.loadEvents(path.join(__dirname, "events/client"), client),
		startup.loadEvents(path.join(__dirname, "events/process"), process),
		startup.loadEvents(path.join(__dirname, "events/player"), manager),
		startup.loadFiles(path.join(__dirname, "commands"), useHooks.get("commands")),
		startup.loadFiles(path.join(__dirname, "functions"), useHooks.get("functions")),
	]);
	client.login(process.env?.TOKEN ?? config?.botConfig?.TOKEN).catch((error) => {
		logger.error("Error logging in:", error);
		logger.error("The Bot Token You Entered Into Your Project Is Incorrect Or Your Bot's INTENTS Are OFF!");
	});
};

initialize().catch((error) => {
	logger.error("Error during initialization:", error);
});

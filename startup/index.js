const { StartupLoader } = require("./loader.js");
const { LoggerFactory } = require("./logger.js");
const { useHooks } = require("zihooks");
const { Collection } = require("discord.js");

class StartupManager {
	constructor(client) {
		this.client = client;
		this.config = this.initCongig();
		this.logger = LoggerFactory.create(this.config);
		this.loader = new StartupLoader(this.config, this.logger);
		this.createFile("./jsons");
		this.web = this.initWeb();
	}

	initCongig() {
		try {
			this.config = require("../config");
		} catch {
			console.warn("No config file found, using default configuration.");
			this.config = require("./defaultconfig");
		}

		useHooks.set("config", this.config);
		return this.config;
	}

	initWeb() {
		this.logger.debug?.("Web runtime disabled in music-only mode.");
		return { server: null, wss: null };
	}

	getConfig() {
		return this.config;
	}

	getLogger() {
		return this.logger;
	}

	loadFiles(directory, collection) {
		return this.loader.loadFiles(directory, collection);
	}

	loadEvents(directory, target) {
		return this.loader.loadEvents(directory, target);
	}

	createFile(directory) {
		return this.loader.createDirectory(directory);
	}

	initHooks() {
		useHooks.set("config", this.config); // Configuration
		useHooks.set("client", this.client); // Discord client
		useHooks.set("welcome", new Collection()); // Welcome messages
		useHooks.set("cooldowns", new Collection()); // Cooldowns
		useHooks.set("responder", new Collection()); // Auto Responder
		useHooks.set("commands", new Collection()); // Slash Commands
		useHooks.set("Mcommands", new Collection()); // Message Commands
		useHooks.set("functions", new Collection()); // Functions
		useHooks.set("extensions", new Collection()); // Extensions
		useHooks.set("logger", this.logger); // LoggerFactory
		useHooks.set("wss", this.web?.wss ?? null); // WebSocket Server
		useHooks.set("server", this.web?.server ?? null); // Web Server
	}
}

module.exports = { StartupManager };

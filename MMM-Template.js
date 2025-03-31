/* Magic Mirror
 * Module: MMM-GeminiChat
 *
 * By Your Name
 * MIT Licensed.
 */
Module.register("MMM-Template", {
  // Default module config.
  defaults: {
    apikey: null, // IMPORTANT: Set this in config.js
    audioSampleRate: 24000,
    audioChannels: 1,
    audioBitDepth: 16,
    interChunkDelayMs: 250,
    initialPrompt: "Hello!", // Optional: Send this text when chat starts
    displayStatus: true, // Show status messages in the module UI
    debug: false // More verbose logging in browser console
  },

  // Properties to store state
  status: "Initializing...",
  isSessionActive: false,

  // Define start sequence.
  start: function() {
    Log.info("Starting module: " + this.name);
    if (!this.config.apikey) {
      Log.error(this.name + ": apiKey is not set in config.js!");
      this.status = "Error: API Key missing";
      this.updateDom();
      return; // Stop if no API key
    }

    // Send configuration to the node helper on start.
    // The helper will wait for the 'START_CHAT' notification to actually connect.
    this.sendSocketNotification("SET_CONFIG", this.config);
    this.status = "Ready. Waiting for START_CHAT.";
    this.updateDom();
  },

  // Override dom generator.
  getDom: function() {
    const wrapper = document.createElement("div");
    wrapper.className = "gemini-chat-status"; // Add a class for potential CSS styling

    if (this.config.displayStatus) {
      wrapper.innerHTML = `<strong>${this.name}:</strong> ${this.status}`;
    } else {
      // If displayStatus is false, maybe show nothing or a minimal indicator
      wrapper.innerHTML = ""; // Or perhaps a small icon/dot if needed
    }
    return wrapper;
  },

  // Define required styles.
  getStyles: function() {
    return ["MMM-GeminiChat.css"]; // Optional CSS file
  },

  // Handle notifications from other modules or core system.
  notificationReceived: function(notification, payload, sender) {
    if (notification === "START_CHAT") {
      Log.info(this.name + " received notification: " + notification);
      if (!this.isSessionActive) {
        this.status = "Starting chat session...";
        this.updateDom();
        this.sendSocketNotification("START_CHAT", this.config.initialPrompt); // Send initial prompt if configured
      } else {
        Log.warn(this.name + ": Chat session already active. Ignoring START_CHAT.");
        this.status = "Chat already active.";
        this.updateDom();
      }
    } else if (notification === "SEND_TEXT") {
      Log.info(this.name + " received notification: " + notification + " with payload: " + payload);
      if (this.isSessionActive) {
        if (payload && typeof payload === 'string' && payload.trim().length > 0) {
          this.status = `Sending: "${payload.substring(0, 30)}${payload.length > 30 ? '...' : ''}"`;
          this.updateDom();
          this.sendSocketNotification("SEND_TEXT", payload.trim());
        } else {
          Log.warn(this.name + ": Received SEND_TEXT without valid text payload.");
          this.status = "Error: Invalid text to send.";
          this.updateDom();
        }
      } else {
        Log.warn(this.name + ": Cannot send text, chat session not active. Send START_CHAT first.");
        this.status = "Error: Chat not active.";
        this.updateDom();
      }
    } else if (notification === "STOP_CHAT") {
      Log.info(this.name + " received notification: " + notification);
      if (this.isSessionActive) {
        this.status = "Stopping chat session...";
        this.updateDom();
        this.sendSocketNotification("STOP_CHAT");
      } else {
        Log.warn(this.name + ": Chat session not active. Ignoring STOP_CHAT.");
        this.status = "Chat not active.";
        this.updateDom();
      }
    }
  },

  // Handle notifications from node_helper.js
  socketNotificationReceived: function(notification, payload) {
    if (this.config.debug) {
      Log.log(this.name + " received socket notification: " + notification + " - Payload: ", payload);
    }

    switch (notification) {
      case "CHAT_STARTED":
        this.status = "Chat session active.";
        this.isSessionActive = true;
        break;
      case "CHAT_ENDED":
        this.status = "Chat session ended." + (payload ? ` Reason: ${payload}` : '');
        this.isSessionActive = false;
        break;
      case "STATUS_UPDATE":
        this.status = payload; // Update status with message from helper
        break;
      case "AUDIO_CHUNK_PLAYING":
        this.status = "Playing audio response...";
        break;
      case "AUDIO_PLAYBACK_COMPLETE":
        this.status = "Audio finished. Ready for input.";
        // Optionally re-enable input here if using a visual indicator
        break;
      case "ERROR":
        this.status = "Error: " + payload;
        this.isSessionActive = false; // Assume session is dead on error
        Log.error(this.name + ": Node helper error - " + payload);
        break;
      default:
        Log.warn(this.name + " received unknown socket notification: " + notification);
        break;
    }
    this.updateDom(); // Update the display whenever status changes
  }
});
/* Magic Mirror
 * Module: MMM-GeminiChat  // <-- Renamed for consistency
 *
 * By Your Name
 * MIT Licensed.
 */
Module.register("MMM-GeminiChat", { // <-- Renamed for consistency
  // Default module config.
  defaults: {
    apiKey: null, // IMPORTANT: Set this in config.js
    audioSampleRate: 24000,
    audioChannels: 1,
    audioBitDepth: 16,
    interChunkDelayMs: 250,
    initialPrompt: "Introduce yourself briefly.", // Default initial prompt
    sendTestMessageInterval: 10000, // Interval in ms to send "testing" (0 to disable)
    testMessage: "testing",        // The message to send periodically
    displayStatus: true,
    debug: false
  },

  // Properties to store state
  status: "Initializing...",
  isSessionActive: false,
  testIntervalId: null, // To store the interval timer ID

  // Define start sequence.
  start: function() {
    Log.info("Starting module: " + this.name);
    this.status = "Initializing...";
    this.isSessionActive = false;
    this.testIntervalId = null; // Ensure interval ID is null initially

    if (!this.config.apiKey) {
      // Ensure the module name in the log matches the registered name
      Log.error(this.name + ": apiKey is not set in config.js!");
      this.status = "Error: API Key missing";
      this.updateDom();
      return; // Stop if no API key
    }

    // Send configuration to the node helper FIRST.
    this.sendSocketNotification("SET_CONFIG", this.config);
    Log.info(this.name + ": Configuration sent to helper.");

    // --- Automatically start chat session ---
    Log.info(this.name + ": Automatically starting chat session.");
    this.status = "Auto-starting chat...";
    this.updateDom();
    // Send the START_CHAT notification to the helper immediately after config
    // Use the configured initialPrompt (can be null or empty string)
    this.sendSocketNotification("START_CHAT", this.config.initialPrompt);

  },

  // Override dom generator.
  getDom: function() {
    const wrapper = document.createElement("div");
    wrapper.className = "gemini-chat-status"; // Matches CSS file name convention

    if (this.config.displayStatus) {
      wrapper.innerHTML = `<strong>${this.name}:</strong> ${this.status}`;
    } else {
      wrapper.innerHTML = "";
    }
    return wrapper;
  },

  // Define required styles.
  getStyles: function() {
    // Matches the assumed filename MMM-GeminiChat.css
    return ["MMM-GeminiChat.css"];
  },

  // Override stop sequence.
  stop: function() {
    Log.info("Stopping module: " + this.name);
    this.clearTestInterval(); // Stop sending test messages
  },

  // --- Function to start the test interval ---
  startTestInterval: function() {
    this.clearTestInterval(); // Clear any existing interval first

    if (this.config.sendTestMessageInterval && this.config.sendTestMessageInterval > 0) {
      Log.info(`${this.name}: Starting test message interval (${this.config.sendTestMessageInterval}ms).`);
      this.testIntervalId = setInterval(() => {
        if (this.isSessionActive) { // Only send if the session is marked as active
          Log.info(`${this.name}: Sending test message: "${this.config.testMessage}"`);
          this.status = `Sending test: "${this.config.testMessage}"`;
          this.updateDom();
          // Send the actual notification to the node_helper
          this.sendSocketNotification("SEND_TEXT", this.config.testMessage);
        } else {
          // Safeguard: If interval runs while session inactive, log and clear.
          Log.warn(`${this.name}: Test interval fired, but session is not active. Clearing interval.`);
          this.clearTestInterval();
        }
      }, this.config.sendTestMessageInterval);
    } else {
      Log.info(`${this.name}: Test message interval is disabled in config.`);
    }
  },

  // --- Function to clear the test interval ---
  clearTestInterval: function() {
    if (this.testIntervalId) {
      Log.info(this.name + ": Clearing test message interval.");
      clearInterval(this.testIntervalId);
      this.testIntervalId = null;
    }
  },

  // Handle notifications from other modules or core system.
  notificationReceived: function(notification, payload, sender) {
    // Handle external SEND_TEXT (e.g., from voice control)
    if (notification === "SEND_TEXT") {
      Log.info(this.name + " received external notification: " + notification + " with payload: " + payload);
      if (this.isSessionActive) {
        if (payload && typeof payload === 'string' && payload.trim().length > 0) {
          this.status = `Sending: "${payload.substring(0, 30)}${payload.length > 30 ? '...' : ''}"`;
          this.updateDom();
          this.sendSocketNotification("SEND_TEXT", payload.trim());
          // Optional: Reset timer if external text is sent?
          // this.startTestInterval();
        } else {
          Log.warn(this.name + ": Received external SEND_TEXT without valid text payload.");
        }
      } else {
        Log.warn(this.name + ": Cannot send external text, chat session not active.");
        this.status = "Error: Chat not active.";
        this.updateDom();
      }
    }
    // Handle external STOP_CHAT
    else if (notification === "STOP_CHAT") {
      Log.info(this.name + " received external notification: " + notification);
      this.clearTestInterval(); // Stop testing if chat stopped externally
      if (this.isSessionActive) {
        this.status = "Stopping chat session...";
        this.updateDom();
        this.sendSocketNotification("STOP_CHAT");
      } else {
        Log.warn(this.name + ": Chat session not active. Ignoring external STOP_CHAT.");
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
        // Start the interval timer AFTER chat is confirmed started
        this.startTestInterval();
        break;
      case "CHAT_ENDED":
        this.status = "Chat session ended." + (payload ? ` Reason: ${payload}` : '');
        this.isSessionActive = false;
        // Stop the interval timer when chat ends
        this.clearTestInterval();
        break;
      case "STATUS_UPDATE":
        // Avoid overwriting critical end/error states
        if (this.isSessionActive) {
            this.status = payload;
        } else if (!this.status.startsWith("Error:") && !this.status.startsWith("Chat session ended")) {
            this.status = payload;
        }
        break;
      case "AUDIO_CHUNK_PLAYING":
        if(this.isSessionActive) this.status = "Playing audio response...";
        break;
      case "AUDIO_PLAYBACK_COMPLETE":
        if(this.isSessionActive) this.status = "Audio finished. Ready for input.";
        break;
      case "ERROR":
        this.status = "Error: " + payload;
        this.isSessionActive = false;
        // Stop the interval timer on error
        this.clearTestInterval();
        Log.error(this.name + ": Node helper error - " + payload);
        break;
      default:
        Log.warn(this.name + " received unknown socket notification: " + notification);
        break;
    }
    this.updateDom(); // Update the display
  }
});
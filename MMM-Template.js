/* Magic Mirror
 * Module: MMM-Template
 *
 * By Your Name
 * MIT Licensed.
 */
Module.register("MMM-Template", { // <-- Renamed Module
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
  isSessionActive: false, // Still track session state, even if interval doesn't check it
  testIntervalId: null, // To store the interval timer ID

  // Define start sequence.
  start: function() {
    // Use this.name which will now be "MMM-Template"
    Log.info("Starting module: " + this.name);
    this.status = "Initializing...";
    this.isSessionActive = false;
    this.testIntervalId = null;

    // API Key check remains important for the helper
    if (!this.config.apiKey) {
      Log.error(this.name + ": apiKey is not set in config.js!");
      this.status = "Error: API Key missing";
      this.updateDom();
      return; // Stop if no API key
    }

    // Send configuration to the node helper FIRST.
    this.sendSocketNotification("SET_CONFIG", this.config);
    Log.info(this.name + ": Configuration sent to helper.");

    // --- MODIFICATION: Start the test interval immediately ---
    Log.info(this.name + ": Starting test message interval immediately.");
    this.startTestInterval(); // Start sending "testing" right away

    // --- Automatically start chat session (after starting interval) ---
    Log.info(this.name + ": Automatically requesting chat session start.");
    this.status = "Requesting chat start...";
    this.updateDom();
    this.sendSocketNotification("START_CHAT", this.config.initialPrompt);

    this.testIntervalId = setInterval(() => {
        // --- MODIFICATION: Removed the check for this.isSessionActive ---
        // Always send the test message for testing purposes.
        // Log.info(`${this.name}: Interval fired. Sending test message: "${this.config.testMessage}" (Session active: ${this.isSessionActive})`);
        this.status = `Sending test: "${this.config.testMessage}"`; // Update status
        this.updateDom();
        // Send the actual notification to the node_helper
        this.sendSocketNotification("SEND_TEXT", this.config.testMessage);

      }, this.config.sendTestMessageInterval);
  },

  // Override dom generator.
  getDom: function() {
    const wrapper = document.createElement("div");
    // Use a class name consistent with the module name
    wrapper.className = "template-chat-status";

    if (this.config.displayStatus) {
      // Use this.name for the display
      wrapper.innerHTML = `<strong>${this.name}:</strong> ${this.status}`;
    } else {
      wrapper.innerHTML = "";
    }
    return wrapper;
  },

  // Define required styles.
  getStyles: function() {
    // Load CSS consistent with the module name
    return ["MMM-Template.css"];
  },

  // Override stop sequence.
  stop: function() {
    Log.info("Stopping module: " + this.name);
    this.clearTestInterval(); // Crucial: Stop sending test messages when module stops
  },

  // --- MODIFIED: Function to start the test interval ---
  startTestInterval: function() {
    this.clearTestInterval(); // Clear any existing interval first

    if (this.config.sendTestMessageInterval && this.config.sendTestMessageInterval > 0) {
      Log.info(`${this.name}: Starting test message interval (${this.config.sendTestMessageInterval}ms). Will send regardless of session state.`);
      this.testIntervalId = setInterval(() => {
        // --- MODIFICATION: Removed the check for this.isSessionActive ---
        // Always send the test message for testing purposes.
        Log.info(`${this.name}: Interval fired. Sending test message: "${this.config.testMessage}" (Session active: ${this.isSessionActive})`);
        this.status = `Sending test: "${this.config.testMessage}"`; // Update status
        this.updateDom();
        // Send the actual notification to the node_helper
        this.sendSocketNotification("SEND_TEXT", this.config.testMessage);

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
      // No check needed for isSessionActive if the goal is just to test sending
      if (payload && typeof payload === 'string' && payload.trim().length > 0) {
          this.status = `Sending external: "${payload.substring(0, 30)}${payload.length > 30 ? '...' : ''}"`;
          this.updateDom();
          this.sendSocketNotification("SEND_TEXT", payload.trim());
      } else {
          Log.warn(this.name + ": Received external SEND_TEXT without valid text payload.");
      }
    }
    // Handle external STOP_CHAT
    else if (notification === "STOP_CHAT") {
      Log.info(this.name + " received external notification: " + notification);
      this.clearTestInterval(); // Stop testing if chat stopped externally
      // Still tell the helper to stop the session if it's active
      if (this.isSessionActive) {
        this.status = "Stopping chat session...";
        this.updateDom();
        this.sendSocketNotification("STOP_CHAT");
      } else {
        // If session wasn't active, we still got the stop command, so ensure interval is cleared.
        Log.warn(this.name + ": External STOP_CHAT received, ensuring interval is clear (session was not marked active).");
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
        // Interval is already running, no need to start it here anymore.
        Log.info(this.name + ": Helper confirmed chat started. Test interval should already be running.");
        break;
      case "CHAT_ENDED":
        this.status = "Chat session ended." + (payload ? ` Reason: ${payload}` : '');
        this.isSessionActive = false;
        // Stop the interval timer when chat ends
        this.clearTestInterval();
        break;
      case "STATUS_UPDATE":
        // Allow status updates, but don't let "Sending test..." be immediately overwritten
        // Maybe prioritize Error/Ended messages
         if (this.status.startsWith("Error:")) { /* Keep Error */ }
         else if (this.status.startsWith("Chat session ended")) { /* Keep Ended */ }
         else { this.status = payload; } // Update status otherwise
        break;
      case "AUDIO_CHUNK_PLAYING":
        // Only update status if not currently showing "Sending test..." to avoid flicker
        if(!this.status.startsWith("Sending test:")) {
            this.status = "Playing audio response...";
        }
        break;
      case "AUDIO_PLAYBACK_COMPLETE":
        // Only update status if not currently showing "Sending test..."
        if(!this.status.startsWith("Sending test:")) {
            this.status = "Audio finished. Ready for input.";
        }
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
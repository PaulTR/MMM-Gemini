/* global Module, Log */

Module.register("MMM-Template", {
  defaults: {
    statusText: "Initializing...",
    apiKey: "",
    triggerInterval: 7000,
    recordingDuration: 3000,
    showIndicators: true,
    idleIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="grey" /></svg>`,
    recordingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"><animate attributeName="opacity" dur="1s" values="0.5;1;0.5" repeatCount="indefinite" /></circle></svg>`,
    processingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="orange"><animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="2s" repeatCount="indefinite"/></svg>`,
    errorIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#333" /><line x1="30" y1="30" x2="70" y2="70" stroke="red" stroke-width="10" /><line x1="70" y1="30" x2="30" y2="70" stroke="red" stroke-width="10" /></svg>`,
    lastResponsePrefix: "Mirror says: ",
    debug: false,
  },

  // --- State ---
  currentState: "INITIALIZING", // INITIALIZING, IDLE, LISTENING, PROCESSING, ERROR
  currentStatusText: "",
  lastResponseText: "",
  triggerTimer: null,
  helperReady: false,

  // --- Lifecycle ---
  start() {
    Log.info(`Starting module: ${this.name}`);
    this.currentStatusText = this.config.statusText;
    this.currentState = "INITIALIZING";
    this.helperReady = false;

    if (!this.config.apiKey) { Log.error(`${this.name}: apiKey missing!`); this.currentStatusText = "Error: API Key missing."; this.currentState = "ERROR"; this.updateDom(); return; }

    this.sendSocketNotification("START_CONNECTION", { apiKey: this.config.apiKey, debug: this.config.debug });
    this.updateDom();
  },

  // --- DOM ---
  getDom() { /* ... existing getDom logic ... */ }, // No changes needed here
    getStyles: function() { return ["MMM-Template.css"]; },

  // --- Socket Notifications ---
  socketNotificationReceived: function (notification, payload) {
    if (this.config.debug) { Log.log(`${this.name} received notification: ${notification}`, payload || ""); }

    switch (notification) {
      case "HELPER_READY":
                if (!this.helperReady) { Log.info(`${this.name}: Helper ready.`); this.helperReady = true; this.currentState = "IDLE"; this.currentStatusText = "Ready."; this.scheduleNextTrigger(); }
        break;
      case "RECORDING_STARTED":
        this.currentState = "LISTENING"; this.currentStatusText = "Listening..."; this.lastResponseText = "";
        break;
      case "RECORDING_STOPPED":
        // Stay in PROCESSING until GEMINI_RESPONSE or HELPER_ERROR is received
        this.currentState = "PROCESSING"; this.currentStatusText = "Processing audio...";
        break;
            case "AUDIO_SENT":
                 // Optionally update status, but stay in PROCESSING
                 if (this.currentState === "LISTENING") { this.currentState = "PROCESSING"; } // Ensure state is processing
                 this.currentStatusText = "Waiting for response...";
                 break;

      // --- UPDATED GEMINI_RESPONSE Handler ---
      case "GEMINI_RESPONSE":
        this.currentState = "IDLE"; // Always transition back to IDLE
        this.currentStatusText = "Ready.";

                // Check the payload to determine what to display
        if (payload && payload.audio) {
          // We received audio data (playback handled by helper)
          this.lastResponseText = "[Audio response received]";
          Log.info(`${this.name} received audio response.`);
        } else if (payload && payload.text) {
                    // Handle potential future text responses or feedback text
                    this.lastResponseText = payload.text;
                    Log.info(`${this.name} received text response/feedback: ${payload.text}`);
                } else {
                    // No audio or text in the payload
                    this.lastResponseText = "[No response data]";
                     Log.warn(`${this.name} received GEMINI_RESPONSE but no audio/text payload.`);
                }

                // Always schedule the next trigger after handling the response
                this.scheduleNextTrigger();
        break;

      case "HELPER_ERROR":
        this.currentState = "ERROR"; this.currentStatusText = `Error: ${payload?.error || 'Unknown'}`; Log.error(`${this.name} helper error: ${payload?.error}`); this.helperReady = false; clearTimeout(this.triggerTimer); this.triggerTimer = null;
        break;
            case "HELPER_LOG": Log.log(`NodeHelper (${this.name}): ${payload}`); break;
    }
    this.updateDom(); // Update display
  },

  // --- Custom Methods ---
  scheduleNextTrigger() { /* ... existing scheduleNextTrigger logic ... */ }, // No changes needed here
  triggerRecording() { /* ... existing triggerRecording logic ... */ }, // No changes needed here

  // --- Stop ---
  stop: function() { /* ... existing stop logic ... */ }, // No changes needed here
});
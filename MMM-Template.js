/* global Module, Log */

Module.register("MMM-Template", {
    defaults: {
        // Display content
        statusText: "Initializing...",
        apiKey: "", // MUST be set in config.js
        // Trigger configuration
        triggerInterval: 7000, // Time between recording triggers in ms (e.g., 7s)
        recordingDuration: 3000, // How long node_helper should record in ms (e.g., 3s)
        // Visual feedback
        showIndicators: true,
        idleIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="grey" /></svg>`,
        recordingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"><animate attributeName="opacity" dur="1s" values="0.5;1;0.5" repeatCount="indefinite" /></circle></svg>`,
        processingIndicatorSvg: `<svg width="50" height="50" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="orange" /></svg>`, // Optional
        lastResponsePrefix: "Mirror says: ",
    },

    // --- Module State ---
    currentState: "INITIALIZING", // INITIALIZING, IDLE, LISTENING, PROCESSING, ERROR
    currentStatusText: "",
    lastResponseText: "",
    triggerTimer: null,

    // --- Lifecycle Functions ---
    start() {
        Log.info(`Starting module: ${this.name}`);
        this.currentStatusText = this.config.statusText;
        this.currentState = "INITIALIZING";

        if (!this.config.apiKey) {
            Log.error(`${this.name}: apiKey not set in config! Module disabled.`);
            this.currentStatusText = "Error: API Key missing in config.js.";
            this.currentState = "ERROR";
            this.updateDom();
            return; // Stop initialization
        }

        // Send API key to helper immediately
        this.sendSocketNotification("START_CHAT", { apikey: this.config.apiKey });

        // Wait for helper to be ready before starting the trigger loop
        // The HELPER_READY notification will call scheduleNextTrigger()
        this.updateDom();
    },

    // --- DOM Generation ---
    getDom() {
        const wrapper = document.createElement("div");
        wrapper.className = "mmm-template-wrapper";

        let indicator = "";
        if (this.config.showIndicators) {
            switch (this.currentState) {
                case "LISTENING":
                    indicator = this.config.recordingIndicatorSvg;
                    break;
                case "PROCESSING":
                    indicator = this.config.processingIndicatorSvg;
                    break;
                case "IDLE":
                case "INITIALIZING": // Can show idle state while initializing backend
                case "ERROR": // Show idle/grey when error occurs
                    indicator = this.config.idleIndicatorSvg;
                    break;
            }
        }

        const statusDiv = document.createElement("div");
        statusDiv.className = "status-text";
        statusDiv.innerHTML = indicator + " " + this.currentStatusText; // Add indicator next to text

        const responseDiv = document.createElement("div");
        responseDiv.className = "response-text";
        responseDiv.innerHTML = this.lastResponseText
            ? `${this.config.lastResponsePrefix}${this.lastResponseText}`
            : ""; // Only show if there's a response

        wrapper.appendChild(statusDiv);
        wrapper.appendChild(responseDiv);

        return wrapper;
    },

    // --- Socket Notifications ---
    socketNotificationReceived: function (notification, payload) {
        Log.log(`${this.name} received notification: ${notification}`); // Debug log

        switch (notification) {
            case "HELPER_READY":
                this.currentState = "IDLE";
                this.currentStatusText = "Ready.";
                this.scheduleNextTrigger(); // Start the recording loop now
                break;
            case "RECORDING_STARTED":
                this.currentState = "LISTENING";
                this.currentStatusText = "Listening...";
                this.lastResponseText = ""; // Clear previous response when starting new recording
                break;
            case "RECORDING_STOPPED":
                // Could transition to PROCESSING here if desired
                 this.currentState = "PROCESSING"; // Assume processing starts after stop
                 this.currentStatusText = "Processing...";
                // Or just go back to IDLE if we don't have a specific processing state
                // this.currentState = "IDLE";
                // this.currentStatusText = "Waiting...";
                break;
             case "SENDING_COMPLETE": // Optional: Notification from helper after last chunk sent
                this.currentState = "PROCESSING";
                this.currentStatusText = "Waiting for response...";
                break;
            case "GEMINI_RESPONSE":
                this.currentState = "IDLE"; // Back to idle after getting response
                this.currentStatusText = "Ready."; // Ready for next trigger
                if (payload && payload.text) {
                    this.lastResponseText = payload.text;
                     Log.info(`${this.name} received text response: ${payload.text}`);
                }
                 if (payload && payload.audio) {
                    // TODO: Handle audio playback if needed (requires browser audio API)
                    Log.info(`${this.name} received audio response (playback not implemented).`);
                     // Could potentially add text like "[Audio response received]"
                     this.lastResponseText += " [Audio response]";
                }
                break;
            case "HELPER_ERROR":
                this.currentState = "ERROR";
                this.currentStatusText = `Error: ${payload.error || 'Unknown helper error'}`;
                Log.error(`${this.name} received error from helper: ${payload.error}`);
                // Stop trying to trigger recordings on error
                clearTimeout(this.triggerTimer);
                this.triggerTimer = null;
                break;
            // case "DATA_SENT": // Usually too frequent to display, but useful for debugging
            //     Log.log(`${this.name}: Node helper confirmed sending a chunk.`);
            //     break;
        }
        this.updateDom(); // Update display after handling notification
    },

    // --- Custom Methods ---
    scheduleNextTrigger() {
        clearTimeout(this.triggerTimer); // Clear any existing timer

        // Only schedule if not in an error state and helper is ready/idle
        if (this.currentState !== "ERROR") {
             Log.info(`${this.name}: Scheduling next recording trigger in ${this.config.triggerInterval} ms.`);
            this.triggerTimer = setTimeout(() => {
                this.triggerRecording();
                // IMPORTANT: Schedule the *next* trigger *after* the current one fires
                // This prevents drift if triggerRecording takes time.
                // The helper manages the actual recording duration.
                this.scheduleNextTrigger();
            }, this.config.triggerInterval);
        } else {
             Log.warn(`${this.name}: Not scheduling trigger due to error state.`);
        }
    },

    triggerRecording() {
        // Only trigger if the system is idle (not already listening or processing)
        // This prevents overlapping requests if interval is shorter than processing time
        if (this.currentState === "IDLE") {
            Log.info(`${this.name}: Triggering recording on node_helper.`);
            this.sendSocketNotification("TRIGGER_RECORDING", {
                duration: this.config.recordingDuration // Tell helper how long to record
            });
            // Update state immediately for responsiveness
            this.currentState = "LISTENING"; // Tentative state until confirmed by helper
            this.currentStatusText = "Starting recording...";
            this.lastResponseText = ""; // Clear last response
            this.updateDom();
        } else {
            Log.warn(`${this.name}: Skipping trigger, system is busy (${this.currentState}).`);
        }
    },

    // --- Stop ---
    stop: function() {
    Log.info(`Stopping module: ${this.name}`);
    clearTimeout(this.triggerTimer);
    this.triggerTimer = null;
        // Optionally notify helper to clean up, though helper stop should handle it
        // this.sendSocketNotification("STOP_HELPER_PROCESSING");
  }

});
/* global Module, Log */

Module.register("MMM-Template", {
    // Default module config
    defaults: {
        apiKey: null, // Required: Set in config.js
        silenceThreshold: 0,
        verboseLogging: false,
        displayStatus: true, // Controls visibility of the status text
        displayResponse: true, // Controls visibility of Gemini's response
        statusUpdateInterval: 500, // How often to update the DOM smoothly (ms)
        errorDisplayDuration: 10000, // How long to show error messages (ms) before reverting status
    },

    // Module properties
    apiInitialized: false,
    isRecording: false,
    statusText: "Loading...",
    detailedStatus: "Waiting for config...", // More specific status for debugging
    responseText: "",
    lastError: null, // Store the last error object/message
    errorTimer: null, // Timer to clear error messages

    // Override start method
    start: function() {
        Log.info(`Starting module: ${this.name}`);
        this.detailedStatus = "Checking API Key...";
        if (!this.config.apiKey) {
            Log.error(`[${this.name}] apiKey is not set in config!`);
            this.statusText = "Error";
            this.detailedStatus = "API Key missing in config.js!";
            this.lastError = { message: this.detailedStatus };
            this.updateDom(this.config.statusUpdateInterval);
            return;
        }

        this.statusText = "Initializing";
        this.detailedStatus = "Sending Config to Helper...";
        this.sendSocketNotification("CONFIG", this.config);
        this.updateDom(); // Initial update

        // Request API initialization after a short delay
        setTimeout(() => {
            Log.info(`[${this.name}] Requesting API Initialization.`);
            this.statusText = "Initializing";
            this.detailedStatus = "Requesting API Connection...";
            this.sendSocketNotification("INITIALIZE_API");
            this.updateDom();
        }, 2000);
    },

    // Clear error status after a delay
    clearErrorStatus: function() {
        if (this.errorTimer) {
            clearTimeout(this.errorTimer);
            this.errorTimer = null;
        }
        this.lastError = null;
        // Revert to a non-error status
        if (this.isRecording) {
             this.statusText = "Status: Listening";
             this.detailedStatus = `Recording: Yes | API: ${this.apiInitialized ? 'Ready' : 'Error'}`;
        } else if (this.apiInitialized) {
             this.statusText = "Status: Ready";
             this.detailedStatus = `Recording: No | API: Ready`;
        } else {
            this.statusText = "Status: Idle";
            this.detailedStatus = `Recording: No | API: Not Initialized`;
        }
        this.updateDom(this.config.statusUpdateInterval);
    },

    // Set error status and schedule clearing
    setErrorStatus: function(prefix, errorPayload) {
         this.lastError = errorPayload || { message: 'Unknown Error' };
         const errorMessage = this.lastError.message || JSON.stringify(this.lastError);
         this.statusText = `Error: ${prefix}`;
         this.detailedStatus = `${prefix} Error: ${errorMessage.substring(0, 80)}${errorMessage.length > 80 ? '...' : ''}`; // Show limited error text
         Log.error(`[${this.name}] ${prefix} Error:`, this.lastError);

         // Clear previous timer if any
        if (this.errorTimer) {
            clearTimeout(this.errorTimer);
        }
        // Set timer to clear the error display
        this.errorTimer = setTimeout(() => {
            this.clearErrorStatus();
        }, this.config.errorDisplayDuration);

        this.updateDom(this.config.statusUpdateInterval);
    },


    // Override socket notification handler
    socketNotificationReceived: function(notification, payload) payload ? JSON.stringify(payload) : 'No Payload');

        // Clear error timer if a non-error related status comes in
        if (!notification.includes("ERROR") && this.errorTimer) {
             // Decide if we should clear the error display immediately upon new status
             // For now, let the timer run its course unless it's a successful status change
        }


        switch (notification) {
            case "API_INITIALIZED":
                this.apiInitialized = true;
                this.lastError = null; // Clear previous errors
                this.statusText = "Status: API Ready";
                this.detailedStatus = "API Initialized. Starting Recorder...";
                Log.info(`[${this.name}] API Initialized. Requesting START_RECORDING.`);
                this.sendSocketNotification("START_RECORDING");
                break;
            case "API_ERROR":
                this.apiInitialized = false;
                this.isRecording = false; // Recording likely stopped or unusable
                this.setErrorStatus("API Init", payload);
                break;
            case "RECORDING_STARTED":
                this.isRecording = true;
                this.lastError = null; // Clear previous errors
                this.statusText = "Status: Listening";
                this.detailedStatus = `Recording: Yes | API: ${this.apiInitialized ? 'Ready' : 'Error'}`;
                Log.info(`[${this.name}] Recording started.`);
                break;
            case "RECORDING_STOPPED":
                // This usually means an unexpected stop from the helper
                this.isRecording = false;
                this.statusText = "Status: Recorder Stopped";
                this.detailedStatus = "Recorder stopped unexpectedly. Attempting restart...";
                Log.warn(`[${this.name}] Recording stopped unexpectedly. Requesting restart.`);
                // Attempt to restart recording after a delay
                setTimeout(() => {
                     if (this.apiInitialized) {
                         this.detailedStatus = "Requesting Recorder Start...";
                         this.sendSocketNotification("START_RECORDING");
                     } else {
                         this.statusText = "Error";
                         this.detailedStatus = "Cannot restart recording: API not ready.";
                         this.setErrorStatus("Restart Failed", {message: "API not ready"});
                     }
                     this.updateDom();
                }, 5000); // Restart after 5 seconds
                break;
            case "RECORDER_ERROR":
                 this.isRecording = false;
                 this.setErrorStatus("Recorder", payload);
                 // Consider retry logic here as well? Maybe handled by RECORDING_STOPPED?
                 break;
             case "GEMINI_MESSAGE": // Assuming text responses for now
                Log.info(`[${this.name}] Received text from Gemini: ${payload?.text}`);
                 // Keep status as listening, but update response text
                 if (this.isRecording) {
                     this.statusText = "Status: Listening"; // Or "Processing"?
                     this.detailedStatus = `Recording: Yes | API: Ready | Last Msg: ${new Date().toLocaleTimeString()}`;
                 }
                if (payload?.text) {
                    this.responseText = payload.text; // Store the latest response
                }
                break;
            case "GEMINI_ERROR":
                 this.setErrorStatus("Gemini", payload);
                 // Assume connection is lost, API needs re-init
                 this.apiInitialized = false;
                 this.isRecording = false;
                 // Attempt re-initialization
                 setTimeout(() => {
                    Log.info(`[${this.name}] Attempting to re-initialize API after Gemini error.`);
                    this.statusText = "Re-initializing";
                    this.detailedStatus = "Attempting API Reconnect after Error...";
                    this.sendSocketNotification("INITIALIZE_API");
                    this.updateDom();
                 }, 10000); // Wait 10 seconds before retry
                 break;
            case "NODE_HELPER_LOG": // For relaying logs from node_helper
                 Log.log(`[${this.name} NodeHelper] ${payload}`);
                 // Optionally display brief log messages? Could get spammy.
                 // this.detailedStatus = `Helper Log: ${payload.substring(0, 50)}...`;
                 break;

        }
        // Don't update DOM immediately here if setErrorStatus was called, it already did.
        if (!notification.includes("ERROR")) {
             this.updateDom(this.config.statusUpdateInterval);
        }
    },

    // Override dom generator
    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.className = "gemini-audio"; // Add a class for potential styling

        // Main Status Display (controlled by config.displayStatus)
        if (this.config.displayStatus) {
            const statusDiv = document.createElement("div");
            statusDiv.className = "status bright"; // Main status is bright

             // Add color coding for status text
             if (this.statusText.toLowerCase().includes("error")) {
                 statusDiv.style.color = "red";
             } else if (this.statusText.toLowerCase().includes("listening")) {
                 statusDiv.style.color = "lightgreen";
             } else if (this.statusText.toLowerCase().includes("ready")) {
                 statusDiv.style.color = "lightblue";
             } else {
                  statusDiv.style.color = "white"; // Default
             }

            statusDiv.innerHTML = this.statusText; // e.g., "Status: Listening", "Error: API Init"
            wrapper.appendChild(statusDiv);

            // Detailed Status Display (always shown if displayStatus is true)
            const detailedStatusDiv = document.createElement("div");
            detailedStatusDiv.className = "detailed-status small dimmed"; // Smaller and dimmer
            detailedStatusDiv.innerHTML = this.detailedStatus; // e.g., "Recording: Yes | API: Ready", "API Error: <message>"
             if (this.lastError) {
                 detailedStatusDiv.style.color = "orange"; // Highlight detailed status if it's showing error info
             }
            wrapper.appendChild(detailedStatusDiv);
        }

        // Gemini Response Display (controlled by config.displayResponse)
        if (this.config.displayResponse && this.responseText) {
            const responseDiv = document.createElement("div");
            responseDiv.className = "response medium light"; // Example classes - adjust as needed
            responseDiv.innerHTML = this.responseText; // Display the stored response text
            wrapper.appendChild(responseDiv);
        }

        // Fallback message if nothing else is displayed
        if (!this.config.displayStatus && !this.config.displayResponse) {
             wrapper.innerHTML = "Gemini Audio"; // Minimal text
             wrapper.className = "status xsmall dimmed";
        }

        return wrapper;
    },

    // Add CSS file if needed (optional styling)
    getStyles: function () {
        return ["MMM-Template.css"]; // We'll create a basic CSS file
    },
});
/* global Module, Log */

Module.register("MMM-Template", {
    // Default module config
    defaults: {
        apiKey: null, // Required: Set in config.js
        silenceThreshold: 0, // Adjust if needed, 0 means record everything
        verboseLogging: false, // Set to true for more console logs from recorder
        displayStatus: true, // Show connection/recording status
        displayResponse: true, // Show text responses from Gemini
    },

    // Module properties
    apiInitialized: false,
    isRecording: false,
    statusText: "Loading...",
    responseText: "",

    // Override start method
    start: function() {
        Log.info(`Starting module: ${this.name}`);
        if (!this.config.apiKey) {
            Log.error(`[${this.name}] apiKey is not set in config!`);
            this.statusText = "Error: API Key missing";
            this.updateDom(500);
            return;
        }

        this.statusText = "Initializing...";
        this.sendSocketNotification("CONFIG", this.config);

        // Request API initialization after a short delay to ensure node_helper is ready
        setTimeout(() => {
            Log.info(`[${this.name}] Requesting API Initialization.`);
            this.sendSocketNotification("INITIALIZE_API");
            this.statusText = "Initializing API...";
            this.updateDom();
        }, 2000);
    },

    // Override socket notification handler
    socketNotificationReceived: function(notification, payload) {
        Log.log(` JSON.stringify(payload)` : 'No Payload'); // Log all notifications

        // *** The extra brace was removed from here ***

        switch (notification) {
            case "API_INITIALIZED":
                this.apiInitialized = true;
                this.statusText = "API Ready. Starting Recording...";
                Log.info(`[${this.name}] API Initialized. Requesting START_RECORDING.`);
                this.sendSocketNotification("START_RECORDING");
                break;
            case "API_ERROR":
                this.apiInitialized = false;
                this.statusText = `API Error: ${payload?.message || 'Unknown Error'}`;
                Log.error(`[${this.name}] API Initialization Error:`, payload);
                break;
            case "RECORDING_STARTED":
                this.isRecording = true;
                this.statusText = "Listening...";
                Log.info(`[${this.name}] Recording started.`);
                break;
            case "RECORDING_STOPPED":
                this.isRecording = false;
                // Decide if you want to show "Stopped" or try restarting
                this.statusText = "Recording stopped. Restarting...";
                Log.warn(`[${this.name}] Recording stopped unexpectedly. Requesting restart.`);
                // Optional: Attempt to restart recording after a delay
                setTimeout(() => {
                     if (this.apiInitialized) {
                         this.sendSocketNotification("START_RECORDING");
                     } else {
                         this.statusText = "Cannot restart recording: API not ready.";
                     }
                }, 5000); // Restart after 5 seconds
                break;
            case "RECORDER_ERROR":
                 this.isRecording = false;
                 this.statusText = `Recorder Error: ${payload?.message || 'Unknown Error'}`;
                 Log.error(`[${this.name}] Recorder Error:`, payload);
                 // Consider retry logic here as well
                 break;
             case "GEMINI_MESSAGE": // Assuming text responses for now
                Log.info(`[${this.name}] Received text from Gemini: ${payload?.text}`);
                if (payload?.text) { // Only update if text is present
                    this.responseText = payload.text; // Store the latest response
                }
                break;
            case "GEMINI_ERROR":
                 Log.error(`[${this.name}] Gemini Live API Error:`, payload);
                 // Handle Gemini specific errors if needed, maybe update status
                 this.statusText = `Gemini Error: ${payload?.message || 'Connection Issue'}`;
                 // You might want to try re-initializing the API connection here
                 this.apiInitialized = false; // Assume connection is lost
                 this.isRecording = false; // Stop recording as connection is down
                 // Attempt re-initialization
                 setTimeout(() => {
                    Log.info(`[${this.name}] Attempting to re-initialize API after error.`);
                    this.sendSocketNotification("INITIALIZE_API");
                    this.statusText = "Re-initializing API...";
                 }, 10000); // Wait 10 seconds before retry
                 break;
            case "NODE_HELPER_LOG": // For relaying logs from node_helper
                 Log.log(`[${this.name} NodeHelper] ${payload}`);
                 break;

        }
        this.updateDom(300); // Update DOM smoothly
    }, // <<< This is the correct closing brace for the function

    // Override dom generator
    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.className = "gemini-audio"; // Add a class for potential styling

        if (this.config.displayStatus) {
            const statusDiv = document.createElement("div");
            statusDiv.className = "status small bright";
            statusDiv.innerHTML = this.statusText;
            wrapper.appendChild(statusDiv);
        }

        if (this.config.displayResponse && this.responseText) {
            const responseDiv = document.createElement("div");
            responseDiv.className = "response medium dimmed"; // Example classes
            responseDiv.innerHTML = this.responseText; // Display the stored response text
            wrapper.appendChild(responseDiv);
        }

        // If neither status nor response is shown, display a minimal message
        if (!this.config.displayStatus && !this.config.displayResponse) {
             wrapper.innerHTML = "Gemini Audio Module Running";
             wrapper.className = "status xsmall dimmed";
        } else if (!this.config.displayResponse && this.responseText) {
             // Clear potential old response text if displayResponse is turned off dynamically (unlikely but safe)
             // this.responseText = ""; // Actually, let's keep it unless explicitly cleared elsewhere
        }

        return wrapper;
    },

     // Add CSS file if needed
    // getStyles: function () {
    //     return ["MMM-Template.css"];
    // },
});